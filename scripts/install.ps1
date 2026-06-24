# Ship Studio -- one-command installer for Windows.
#
#   irm https://ship.studio/install.ps1 | iex
#
# Downloads the latest build, runs the installer silently, and launches the app.
# The installer .exe isn't code-signed, so we strip the "Mark of the Web"
# (Unblock-File) before running it -- the Windows equivalent of clearing the
# macOS quarantine flag, so SmartScreen doesn't block it.
#
# Options (env vars):
#   $env:SHIPSTUDIO_NO_LAUNCH = '1'   install but don't open the app afterwards

$ErrorActionPreference = 'Stop'

$asset = 'ShipStudio_windows-x86_64-setup.exe'
$url   = "https://github.com/ship-studio/releases/releases/latest/download/$asset"
$out   = Join-Path $env:TEMP $asset

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'Ship Studio requires 64-bit Windows.'
}

Say 'Downloading Ship Studio...'
# TLS 1.2 for older PowerShell; turning the progress UI off makes IWR far faster.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $out

Say 'Preparing installer...'
Unblock-File -Path $out   # strip Mark-of-the-Web so SmartScreen does not block it

Say 'Installing (runs silently)...'
Start-Process -FilePath $out -ArgumentList '/S' -Wait

if (-not $env:SHIPSTUDIO_NO_LAUNCH) {
  Say 'Launching Ship Studio...'
  $menus = @(
    (Join-Path $env:APPDATA    'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  $shortcut = Get-ChildItem -Path $menus -Recurse -Filter 'Ship Studio*.lnk' -ErrorAction SilentlyContinue |
              Select-Object -First 1
  if ($shortcut) {
    Start-Process -FilePath $shortcut.FullName
  } else {
    Say "Installed. Launch 'Ship Studio' from the Start Menu."
  }
}

Remove-Item $out -ErrorAction SilentlyContinue
Say 'Done.'
