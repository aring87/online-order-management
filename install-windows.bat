@echo off
title Install Butcher Shop Orders
cd /d "%~dp0"
echo.
echo  Butcher Shop Orders - one-time setup
echo  ------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed on this computer.
  echo  Download the "LTS" version from https://nodejs.org , install it, then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

echo  Installing what the program needs (about a minute the first time)...
call npm install --omit=dev --no-audit --no-fund
if not exist .env copy .env.example .env >nul

echo.
choice /C YN /M " Start the orders program automatically when this computer starts"
set AUTO=
if errorlevel 2 (set AUTO=) else (set AUTO=-AutoStart)

echo.
echo  Creating shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1" %AUTO%
if errorlevel 1 (
  echo.
  echo  Something went wrong creating the shortcuts. You can still use start-windows.bat.
  pause
  exit /b 1
)

echo.
echo  Done! Use the "Butcher Shop Orders" icon on your desktop or in the Start menu.
echo  To stop the program: Start menu - "Stop Butcher Shop Orders".
echo.
echo  Opening the program now...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\windows\open.ps1"
timeout /t 5 >nul
