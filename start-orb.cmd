@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title dsh-orb standalone

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\koffi\index.js" (
  echo [ERROR] node_modules\koffi not found.
  echo Keep this launcher in the dsh-orb-src folder that contains node_modules.
  pause
  exit /b 1
)

if "%DSH_ORB_STANDALONE_PORT%"=="" set "DSH_ORB_STANDALONE_PORT=3737"
set "ORB_URL=http://127.0.0.1:%DSH_ORB_STANDALONE_PORT%"
set "DSH_ORB_OPEN_CONSOLE_ON_MISSING_KEY=1"

echo Starting dsh-orb standalone...
echo URL:  %ORB_URL%
echo Stop: press Ctrl+C in this window.
echo Floating ball: right-click it and choose "Open floating-ball settings" for the API key.
echo.

node .\standalone\server.mjs
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" echo [ERROR] Server exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
