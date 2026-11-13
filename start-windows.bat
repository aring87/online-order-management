@echo off
title Butcher Shop Orders
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Download the "LTS" version from https://nodejs.org , install it, then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo  First-time setup, please wait...
  call npm install --omit=dev --no-audit --no-fund
)
if not exist .env copy .env.example .env >nul

set OPEN_BROWSER=1
node --no-warnings --env-file-if-exists=.env src/server.js
pause
