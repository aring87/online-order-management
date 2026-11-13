# Stops the Butcher Shop Orders program if it's running in the background.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$server = "$root\src\server.js"
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($server.ToLower()) }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

Add-Type -AssemblyName PresentationFramework
if ($procs) { $msg = 'The orders program has been stopped. Your data is saved.' }
else { $msg = 'The orders program was not running.' }
if (-not $args -or $args[0] -ne '-Quiet') { [void][System.Windows.MessageBox]::Show($msg, 'Butcher Shop Orders') }
