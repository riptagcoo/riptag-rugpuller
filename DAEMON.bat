@echo off
cd /d "%~dp0"
echo.
echo  Riptag Rugpuller - Scheduler Daemon
echo  Keep this window open to run scheduled deploys
echo.
node agent.js --daemon
pause
