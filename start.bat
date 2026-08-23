@echo off
cd /d "%~dp0app"
if not exist "node_modules" (
  echo Ilk kurulum yapiliyor (npm install)...
  call npm install
)
start "" "node_modules\electron\dist\electron.exe" "."
