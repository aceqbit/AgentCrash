$ErrorActionPreference = 'Stop'
foreach ($p in 'gateway','mock-servers') {
    Push-Location (Join-Path $PSScriptRoot "..\$p")
    npm run build --silent; if ($LASTEXITCODE) { exit 1 }
    Pop-Location
}