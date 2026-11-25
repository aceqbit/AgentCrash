$ErrorActionPreference = 'Stop'
$runDir = Join-Path $PSScriptRoot '..\.run'
if (Test-Path $runDir) {
    Get-ChildItem $runDir -Filter *.pid | ForEach-Object {
        $procId = [int](Get-Content $_.FullName)
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Remove-Item $_.FullName
    }
}
Write-Host 'background processes stopped (PostgreSQL left running)'