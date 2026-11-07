@echo off
setlocal
cd /d "%~dp0"
title teleagent-proxy

where node >nul 2>nul
if errorlevel 1 (
  echo [teleagent] Node.js not found. Install Node.js 20+ first: https://nodejs.org
  pause
  exit /b 1
)

echo [teleagent] Starting gateway, kernel warm-up takes 1-2 minutes...
echo [teleagent] Console page will open automatically when ready.
echo.

set "TA_OPEN_ADMIN=1"
node server.mjs

echo.
echo [teleagent] Gateway stopped (exit code %errorlevel%).
pause
