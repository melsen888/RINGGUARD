# Membaca functions/.secret.local lalu menyimpan setiap nilai ke Secret Manager Firebase.
# Contoh:
#   powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1 -ProjectId nama-project
# Jika -ProjectId tidak diisi, project aktif dari `firebase use` yang dipakai.

param(
  [string]$ProjectId = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  throw "Firebase CLI belum terpasang. Jalankan: npm install -g firebase-tools"
}

$root = Split-Path $PSScriptRoot -Parent
$file = Join-Path $root "functions\.secret.local"
if (-not (Test-Path $file)) { throw "File tidak ditemukan: $file" }

$extra = @()
if ($ProjectId) { $extra = @("--project", $ProjectId) }
$tmp = Join-Path $env:TEMP ("fb-secret-" + [guid]::NewGuid().ToString("N") + ".txt")

try {
  foreach ($line in Get-Content $file) {
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim().Trim('"')
      if (-not $value) { continue }
      [System.IO.File]::WriteAllText($tmp, $value, [System.Text.Encoding]::ASCII)
      Write-Host "Menyetel secret $name ..."
      & firebase functions:secrets:set $name --data-file $tmp @extra
      if ($LASTEXITCODE -ne 0) { throw "Gagal menyetel secret $name" }
    }
  }
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Selesai. Lanjutkan dengan: firebase deploy --only functions"
