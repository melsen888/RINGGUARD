# Mendaftarkan webhook bot Telegram ke fungsi telegramWebhook yang sudah di-deploy.
# Contoh:
#   powershell -ExecutionPolicy Bypass -File scripts\activate-telegram.ps1 -ProjectId nama-project
# Kunci EXPORT_KEY dibaca otomatis dari functions/.secret.local.

param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$Region = "asia-southeast1"
)

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$file = Join-Path $root "functions\.secret.local"
if (-not (Test-Path $file)) { throw "File tidak ditemukan: $file" }

$line = Get-Content $file | Where-Object { $_ -match '^\s*EXPORT_KEY\s*=' } | Select-Object -First 1
if (-not $line) { throw "EXPORT_KEY tidak ada di $file" }
$key = ($line -replace '^\s*EXPORT_KEY\s*=\s*', '').Trim().Trim('"')

$uri = "https://$Region-$ProjectId.cloudfunctions.net/telegramSetup"
Write-Host "Mendaftarkan webhook: $uri"
$result = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ "x-api-key" = $key }
$result | ConvertTo-Json -Depth 5
