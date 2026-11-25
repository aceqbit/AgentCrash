$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
foreach ($p in 'gateway','mock-servers') {
    Push-Location (Join-Path $root $p)
    if (-not (Test-Path node_modules)) { npm ci --silent; if ($LASTEXITCODE) { exit 1 } }
    Pop-Location
}
foreach ($p in 'runtime','verifier') {
    uv --project (Join-Path $root $p) sync --quiet; if ($LASTEXITCODE) { exit 1 }
}
