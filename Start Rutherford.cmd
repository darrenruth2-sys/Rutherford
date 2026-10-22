@echo off
title Rutherford
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Get the LTS version from https://nodejs.org then run this again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -v') do set NODEV=%%v
set NODEV=%NODEV:v=%
if %NODEV% LSS 20 (
  echo  Rutherford needs Node.js 20 or newer. You have:
  node -v
  echo  Update from https://nodejs.org
  pause
  exit /b 1
)
node server.cjs
echo.
echo  Rutherford stopped.
pause
