# Install the latest published Harbr Windows package.
$ErrorActionPreference = 'Stop'

$asset = 'Harbr_windows-x86_64-setup.exe'
$url = "https://github.com/kacigaya/harbr/releases/latest/download/$asset"
$output = Join-Path $env:TEMP $asset

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'Harbr requires 64-bit Windows.'
}

Write-Host 'Downloading Harbr...' -ForegroundColor Green
Invoke-WebRequest -Uri $url -OutFile $output
Write-Host 'Starting the Harbr installer...' -ForegroundColor Green
Start-Process -FilePath $output -Wait
Remove-Item $output -ErrorAction SilentlyContinue
