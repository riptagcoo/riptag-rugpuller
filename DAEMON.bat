@echo off
cd /d "C:\Users\New User\Documents\riptag-rugpuller"
echo.
echo  Riptag Rugpuller - Scheduler Daemon
echo  Keep this window open to run scheduled deploys
echo.
node agent.js --daemon
pause
