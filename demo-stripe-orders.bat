@echo off
title DEMO - fake paid Stripe orders
cd /d "%~dp0"
echo.
echo  DEMO: this pretends to be Stripe telling the program "a customer just paid".
echo  Nothing is charged - the customers and payments are made up.
echo  Open the program first, go to "Online orders", and watch them arrive marked Paid.
echo.
node scripts\demo-stripe-orders.js %*
pause
