@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [Paper Cup] Node.js not found. Please install Node.js 22.19 or later: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\start.mjs" %*
if errorlevel 1 (
  echo.
  echo [Paper Cup] Startup failed. Please check the log above.
  pause
  exit /b 1
)
endlocal
