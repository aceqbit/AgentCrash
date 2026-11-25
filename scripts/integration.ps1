$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
& "$PSScriptRoot/up.ps1"; & "$PSScriptRoot/migrate.ps1"; & "$PSScriptRoot/build.ps1"
$env:INTEGRATION = '1'
foreach ($p in 'gateway','mock-servers') {
    Push-Location (Join-Path $root $p)
    npx vitest run --passWithNoTests; if ($LASTEXITCODE) { exit 1 }
    Pop-Location
}