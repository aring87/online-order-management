@echo off
title Remove Butcher Shop Orders shortcuts
cd /d "%~dp0"
echo.
echo  Removing the Butcher Shop Orders shortcuts and stopping the program.
echo  Your orders and customers are NOT deleted (they stay in the data folder).
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\uninstall.ps1"
echo.
echo  Done.
pause
