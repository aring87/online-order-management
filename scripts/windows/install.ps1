# Creates the shortcuts: Desktop + Start menu ("Butcher Shop Orders" and "Stop Butcher Shop Orders"),
# and optionally one in the Startup folder so the program starts quietly when Windows starts.
param([switch]$AutoStart)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$icon = "$root\public\icons\orders.ico,0"
$shell = New-Object -ComObject WScript.Shell

function New-Shortcut($path, $script, $extra, $description) {
    $s = $shell.CreateShortcut($path)
    $s.TargetPath = $ps
    $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\windows\$script`" $extra".Trim()
    $s.WorkingDirectory = $root
    $s.IconLocation = $icon
    $s.WindowStyle = 7   # minimized, so nothing flashes on screen
    $s.Description = $description
    $s.Save()
    Write-Host "  created $path"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$startup = [Environment]::GetFolderPath('Startup')

New-Shortcut "$desktop\Butcher Shop Orders.lnk" 'open.ps1' '' 'Open the Butcher Shop orders program'
New-Shortcut "$programs\Butcher Shop Orders.lnk" 'open.ps1' '' 'Open the Butcher Shop orders program'
New-Shortcut "$programs\Stop Butcher Shop Orders.lnk" 'stop.ps1' '' 'Stop the Butcher Shop orders program'

$startupLink = "$startup\Butcher Shop Orders (background).lnk"
if ($AutoStart) {
    New-Shortcut $startupLink 'open.ps1' '-Background' 'Start the Butcher Shop orders program when Windows starts'
} elseif (Test-Path $startupLink) {
    Remove-Item $startupLink
    Write-Host "  removed $startupLink"
}
