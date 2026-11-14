param([switch]$Background, [ValidateRange(1024, 65535)][int]$Port = 19330)
$ErrorActionPreference = 'Stop'
$origin = "http://127.0.0.1:$Port"
$logPath = Join-Path $PSScriptRoot 'launch.jsonl'
$startupMutex = $null
$startupMutexHeld = $false
function Write-LaunchLog([string]$EventName, [string]$Detail) {
    @{ at = [DateTime]::UtcNow.ToString('o'); event = $EventName; detail = $Detail; background = [bool]$Background } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $logPath -Encoding UTF8
}
function Get-UpNoteEndpoint {
    try {
        $reply = Invoke-RestMethod -Uri "$origin/json/version" -TimeoutSec 1
        if ($reply.'User-Agent' -match 'UpNote/') { return $reply }
    } catch { }
    return $null
}
try {
    # Different Codex/MCP processes must share the same app-start reservation.
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $startupMutex = New-Object System.Threading.Mutex($false, "Local\UpNoteMcp-$sid-$Port")
    try { $startupMutexHeld = $startupMutex.WaitOne(20000) }
    catch [System.Threading.AbandonedMutexException] { $startupMutexHeld = $true }
    if (-not $startupMutexHeld) { throw 'Another UpNote startup request is still running. Try connecting again shortly.' }
    # Resolve the current Store package every time, including after app updates.
    $packages = @(Get-AppxPackage -Name '*UpNote*')
    if ($packages.Count -ne 1) { throw 'Cannot uniquely resolve the installed UpNote Store package.' }
    $exePath = Join-Path $packages[0].InstallLocation 'app\UpNote.exe'
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw 'The installed UpNote.exe was not found.' }
    $existing = @(Get-Process -Name UpNote -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        if (-not (Get-UpNoteEndpoint)) {
            throw 'UpNote is already running without the MCP connection. Save your changes and exit UpNote normally, then use this shortcut again.'
        }
        if (-not $Background) {
            # Its ordinary second-instance handler shows the existing main window.
            Start-Process -FilePath $exePath -WindowStyle Hidden | Out-Null
        }
        Write-LaunchLog 'reused' $origin
        exit 0
    }
    $arguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port")
    if ($Background) { $arguments += '--auto-start-in-background' }
    $process = Start-Process -FilePath $exePath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Get-UpNoteEndpoint) {
            Write-LaunchLog 'started' "pid=$($process.Id); origin=$origin"
            exit 0
        }
        $process.Refresh()
        if ($process.HasExited) { throw 'UpNote exited before the MCP connection was ready.' }
    }
    throw 'UpNote started but its MCP connection was not ready in time. It was not force-terminated.'
} catch {
    Write-LaunchLog 'error' $_.Exception.Message
    [Console]::Error.WriteLine($_.Exception.Message)
    if (-not $Background) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'UpNote', 'OK', 'Error') | Out-Null
    }
    exit 1
} finally {
    if ($startupMutexHeld) { $startupMutex.ReleaseMutex() }
    if ($null -ne $startupMutex) { $startupMutex.Dispose() }
}
