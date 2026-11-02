@echo off
setlocal
cd /d "%~dp0.."

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo Node.js tidak ditemukan.
    echo Install dulu: winget install OpenJS.NodeJS.LTS
    echo Lalu tutup dan buka ulang terminal.
    pause
    exit /b 1
  )
)

echo Menjalankan bot RINGGUARD (mode demo)...
echo Tekan Ctrl+C untuk berhenti.
echo.
"%NODE%" bot\local-bot.js --demo

echo.
echo Bot berhenti.
pause
