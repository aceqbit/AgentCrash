$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
foreach ($p in 'runtime','verifier') {
    Push-Location (Join-Path $root $p)
    uv run ruff check .; if ($LASTEXITCODE) { exit 1 }
    uv run mypy src; if ($LASTEXITCODE) { exit 1 }
    Pop-Location
}
foreach ($p in 'gateway','mock-servers') {
    Push-Location (Join-Path $root $p)
    npx tsc --noEmit; if ($LASTEXITCODE) { exit 1 }
    npx eslint .; if ($LASTEXITCODE) { exit 1 }
    Pop-Location
}