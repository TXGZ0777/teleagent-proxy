@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title teleagent-proxy stop

set "PIDFILE=runtime\proxy.pid"

if not exist "%PIDFILE%" (
  echo [teleagent] PID file not found: %PIDFILE%
  echo [teleagent] Proxy may not be running, or was not started via start.vbs.
  goto :fallback
)

set /p PID=<"%PIDFILE%"
set "PID=%PID: =%"

if not defined PID (
  echo [teleagent] PID file is empty.
  goto :fallback
)

echo [teleagent] Read PID=%PID%, checking if it is alive...

rem ---- Check the PID exists. The pid file is written by server.mjs itself,
rem      so its presence already identifies our process (no wmic needed; wmic is
rem      unreliable in restricted/sandboxed environments). ----
tasklist /FI "PID eq %PID%" 2>nul | findstr /i "%PID%" >nul
if errorlevel 1 (
  echo [teleagent] Process %PID% does not exist, likely already stopped.
  del "%PIDFILE%" >nul 2>&1
  goto :fallback
)

rem ---- Extra guard: the process must be node.exe (pid file is written by our server.mjs,
rem      but PIDs can be recycled; refuse to kill a non-node process). ----
set "ISNODE="
for /f "tokens=1" %%N in ('tasklist /FI "PID eq %PID%" /NH 2^>nul') do set "ISNODE=%%N"
if /i not "%ISNODE%"=="node.exe" (
  echo [teleagent] WARNING: PID=%PID% is %ISNODE%, not node.exe. Refusing to kill.
  del "%PIDFILE%" >nul 2>&1
  goto :fallback
)

rem ---- Graceful stop (Windows taskkill without /F sends SIGHUP; server.mjs handles it) ----
echo [teleagent] Stopping proxy PID=%PID% ...
taskkill /PID %PID% >nul 2>&1

rem ---- Wait up to 15 seconds for a clean exit ----
set /a WAITED=0
:waitloop
tasklist /FI "PID eq %PID%" 2>nul | findstr /i "%PID%" >nul
if errorlevel 1 goto :stopped
set /a WAITED+=1
if %WAITED% GEQ 15 (
  echo [teleagent] Not exited after 15s, force killing...
  taskkill /F /PID %PID% >nul 2>&1
  goto :stopped
)
ping -n 2 127.0.0.1 >nul 2>&1
goto :waitloop

:stopped
del "%PIDFILE%" >nul 2>&1
echo [teleagent] Stopped.
goto :end

:fallback
echo.
echo [teleagent] To check for leftovers manually:
echo   netstat -ano ^| findstr ":8787.*LISTENING"
echo or end the matching node.exe in Task Manager.

:end
endlocal
