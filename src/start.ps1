<#
.SYNOPSIS
    Startet SAFe WSJF im Browser.

.DESCRIPTION
    Öffnet die index.html aus demselben Ordner. Es wird kein Server gestartet und
    nichts installiert. Das Skript verwendet ausschliesslich Cmdlets und läuft damit
    auch ohne Adminrechte und im PowerShell Constrained Language Mode.

    Alternativ genügt ein Doppelklick auf index.html oder start.cmd.

.PARAMETER Edge
    Erzwingt Microsoft Edge statt des Standardbrowsers.

.EXAMPLE
    .\start.ps1

.EXAMPLE
    .\start.ps1 -Edge

.NOTES
    Wird das Skript mit "nicht digital signiert" abgelehnt, trägt die Datei nach dem
    Download die Internet-Markierung. Einmalig entfernen mit:
        Unblock-File -Path .\start.ps1
    Oder vor dem Entpacken das ZIP in den Dateieigenschaften "Zulassen".
#>
[CmdletBinding()]
param(
    [switch]$Edge
)

$ErrorActionPreference = 'Stop'

$index = Join-Path -Path $PSScriptRoot -ChildPath 'index.html'
if (-not (Test-Path -LiteralPath $index)) {
    Write-Error "index.html wurde nicht gefunden: $index"
    exit 1
}

if ($Edge) {
    $candidates = @()
    foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($root) {
            $candidates += Join-Path -Path $root -ChildPath 'Microsoft\Edge\Application\msedge.exe'
        }
    }
    $edgeExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if ($edgeExe) {
        Start-Process -FilePath $edgeExe -ArgumentList ('"{0}"' -f $index)
    } else {
        # Edge liegt an einem unüblichen Ort: über den Protokoll-Handler öffnen.
        $uri = ([uri]$index).AbsoluteUri
        Start-Process -FilePath ('microsoft-edge:{0}' -f $uri)
    }
} else {
    Start-Process -FilePath $index
}

Write-Host "SAFe WSJF geöffnet: $index"
