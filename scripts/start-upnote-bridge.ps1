param(
    [ValidateRange(1024, 65535)][int]$Port = 19330,
    [string]$ExePath
)
$ErrorActionPreference = 'Stop'
if (Get-Process -Name UpNote -ErrorAction SilentlyContinue) {
    throw 'UpNote is already running. Exit it normally first; this launcher never terminates an existing app or discards unsaved changes.'
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. Choose another port."
}
if (-not $ExePath) {
    $package = @(Get-AppxPackage -Name '*UpNote*')
    if ($package.Count -ne 1) { throw 'Cannot uniquely locate UpNote. Supply -ExePath with the installed UpNote.exe.' }
    $ExePath = Join-Path $package[0].InstallLocation 'app\UpNote.exe'
}
$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
if ([IO.Path]::GetFileName($resolvedExe) -ine 'UpNote.exe') { throw 'Expected an installed UpNote.exe.' }
# No persisted app/OS configuration, no profile copy, and no binary modification.
$launched = Start-Process -FilePath $resolvedExe -ArgumentList @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port") -WindowStyle Hidden -PassThru
$origin = "http://127.0.0.1:$Port"
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $version = $null
    try { $version = Invoke-RestMethod -Uri "$origin/json/version" -TimeoutSec 1 } catch { }
    if ($null -eq $version) { continue }
    if ($version.'User-Agent' -notmatch 'UpNote/') { throw 'The listening service is not UpNote.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') -or $_.OwningProcess -ne $launched.Id }) {
        throw 'CDP is not bound exclusively to this UpNote process on loopback. Quit UpNote normally before using this bridge.'
    }
    # Some Windows environments omit the listener from Get-NetTCPConnection.
    # Verify the owning browser PID through CDP even when that table is empty.
    $bunExe = (Get-Command bun.exe -ErrorAction Stop).Source
    & $bunExe run (Join-Path $PSScriptRoot 'verify-upnote-cdp-owner.ts') $origin $launched.Id
    if ($LASTEXITCODE -ne 0) { throw 'The CDP endpoint owner could not be verified. Do not configure the bridge.' }
    [pscustomobject]@{ StartedPid = $launched.Id; UPNOTE_CDP_URL = $origin; ListenerTableAvailable = ($listeners.Count -gt 0); BrowserOwnerVerified = $true; Note = 'Configure this origin in the MCP environment and reconnect MCP. The local debug port remains open until UpNote exits.' } | ConvertTo-Json
    exit 0
}
throw 'UpNote started but its CDP endpoint was not ready. No existing app was terminated; inspect it and quit normally if you do not want to leave debugging enabled.'
