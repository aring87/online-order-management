# Opens the Butcher Shop Orders program.
# Starts the server quietly in the background if it isn't running yet (no black window),
# then opens the program in its own app window (Microsoft Edge "app mode"), or the default browser.
#   -Background   only start the server, don't open a window (used when Windows starts)
param([switch]$Background)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

function Show-Message($text) {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($text, 'Butcher Shop Orders')
}

# Port from .env (default 3000)
$port = 3000
if (Test-Path "$root\.env") {
    $line = Get-Content "$root\.env" | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | Select-Object -First 1
    if ($line -and $line -match '(\d+)') { $port = [int]$Matches[1] }
}
$url = "http://localhost:$port/admin"

function Test-Running {
    $client = New-Object System.Net.Sockets.TcpClient
    try { return $client.ConnectAsync('127.0.0.1', $port).Wait(500) -and $client.Connected }
    catch { return $false }
    finally { $client.Dispose() }
}

if (-not (Test-Running)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")) { $node = "$env:ProgramFiles\nodejs\node.exe" }
    if (-not $node) {
        Show-Message "Node.js is not installed on this computer.`n`nDownload the LTS version from https://nodejs.org, install it, then try again."
        Start-Process 'https://nodejs.org'
        exit 1
    }

    if (-not (Test-Path "$root\node_modules")) {
        $npm = Join-Path (Split-Path $node) 'npm.cmd'
        Start-Process -FilePath $npm -ArgumentList 'install --omit=dev --no-audit --no-fund' -WorkingDirectory $root -WindowStyle Hidden -Wait
    }
    if (-not (Test-Path "$root\.env") -and (Test-Path "$root\.env.example")) { Copy-Item "$root\.env.example" "$root\.env" }
    New-Item -ItemType Directory -Force -Path "$root\data" | Out-Null

    $serverArgs = "--no-warnings --env-file-if-exists=.env `"$root\src\server.js`""
    Start-Process -FilePath $node -ArgumentList $serverArgs -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput "$root\data\server.log" -RedirectStandardError "$root\data\server-error.log"

    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Running)) {
        if ((Get-Date) -gt $deadline) {
            Show-Message "The orders program didn't start.`n`nDetails are in:`n$root\data\server-error.log`n`nTry start-windows.bat to see what's wrong."
            exit 1
        }
        Start-Sleep -Milliseconds 300
    }
}

if ($Background) { exit 0 }

# Open in its own window without browser tabs/address bar if Edge is available.
$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($edge) { Start-Process -FilePath $edge -ArgumentList "--app=$url" }
else { Start-Process $url }
