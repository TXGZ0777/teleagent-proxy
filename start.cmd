@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [teleagent] 找不到 node，请先安装 Node.js 20+
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause
