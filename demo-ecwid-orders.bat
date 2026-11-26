@echo off
title DEMO - fake Ecwid store orders
cd /d "%~dp0"
echo.
echo  DEMO: this pretends to be the website's online store ("My e-Shop") receiving orders.
echo  The orders are FAKE. Open the program first, go to "Online orders", and watch them arrive.
echo.
node scripts\demo-ecwid-orders.js %*
pause
