param([Parameter(Mandatory = $true)][string]$PayloadPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($payload.kind -ne 'upnote-app-edit-v1' -or $null -eq $payload.cfHtmlBase64 -or $null -eq $payload.text) {
    throw 'Invalid note clipboard payload.'
}
# A .NET string for CF_HTML is encoded using the Windows ANSI code page.
# Supply a raw UTF-8 stream instead, preserving both Japanese and byte offsets.
$htmlBytes = [Convert]::FromBase64String([string]$payload.cfHtmlBase64)
$htmlStream = New-Object System.IO.MemoryStream(, $htmlBytes)
$data = New-Object System.Windows.Forms.DataObject
$data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [string]$payload.text)
$data.SetData([System.Windows.Forms.DataFormats]::Html, $false, $htmlStream)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
