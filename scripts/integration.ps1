$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
& "$PSScriptRoot/up.ps1" -NoStack
$env:INTEGRATION = '1'
foreach ($p in 'gateway','mock-servers') {
    Push-Location (Join-Path $root $p)
    npx vitest run --passWithNoTests; if ($LASTEXITCODE) { Pop-Location; exit 1 }
    Pop-Location
}
& "$PSScriptRoot/up.ps1"
try {
    foreach ($p in 'runtime','verifier') {
        Push-Location (Join-Path $root $p)
        uv run pytest; if ($LASTEXITCODE) { Pop-Location; exit 1 }
        Pop-Location
    }
} finally { & "$PSScriptRoot/down.ps1" }