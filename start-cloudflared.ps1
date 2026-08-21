param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredCommand) {
  Write-Host 'cloudflared was not found.' -ForegroundColor Red
  Write-Host 'Install it with:' -ForegroundColor Yellow
  Write-Host '  winget install --id Cloudflare.cloudflared'
  exit 1
}

Write-Host "Starting tunnel for http://127.0.0.1:$Port ..." -ForegroundColor Cyan
& $cloudflaredCommand.Source tunnel --url "http://127.0.0.1:$Port"