$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
foreach ($p in 'runtime','verifier') {
    Push-Location (Join-Path $root $p)
    uv run pytest; if ($LASTEXITCODE) { exit 1 }
    Pop-Location
}
foreach ($p in 'gateway','mock-servers') {
    Push-Location (Join-Path $root $p)
    npx vitest run --passWithNoTests; if ($LASTEXITCODE) { exit 1 }
    Pop-Location
}