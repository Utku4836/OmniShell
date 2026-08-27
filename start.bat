@echo off
setlocal
cd /d "%~dp0app"

where npm >nul 2>nul
if errorlevel 1 (
  echo [OmniShell] Node.js 22.19 or newer is required.
  echo Download it from https://nodejs.org/
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)"
if errorlevel 1 (
  echo [OmniShell] Node.js 22.19 or newer is required.
  echo Download it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [OmniShell] Installing application dependencies...
  call npm ci --no-fund --no-audit
  if errorlevel 1 (
    echo [OmniShell] Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [OmniShell] Electron is missing. Run npm ci inside the app folder.
  pause
  exit /b 1
)

start "OmniShell" "node_modules\electron\dist\electron.exe" "."
