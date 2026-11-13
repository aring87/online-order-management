@echo off
title DEMO - fake online orders
cd /d "%~dp0"
echo.
echo  DEMO: this sends FAKE online orders to the orders program, as if customers
echo  were ordering on the website. Open the program first, go to "Online orders",
echo  and watch them arrive.
echo.
node scripts\demo-online-orders.js %*
pause
