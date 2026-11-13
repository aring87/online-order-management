# Removes the shortcuts created by install.ps1 and stops the program. Does NOT delete any data.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
& "$root\scripts\windows\stop.ps1" -Quiet
$links = @(
    "$([Environment]::GetFolderPath('Desktop'))\Butcher Shop Orders.lnk",
    "$([Environment]::GetFolderPath('Programs'))\Butcher Shop Orders.lnk",
    "$([Environment]::GetFolderPath('Programs'))\Stop Butcher Shop Orders.lnk",
    "$([Environment]::GetFolderPath('Startup'))\Butcher Shop Orders (background).lnk"
)
foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l; Write-Host "  removed $l" } }
