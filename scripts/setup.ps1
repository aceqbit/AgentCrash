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
# Keep .env in sync with .env.example (add missing keys only; never overwrite values).
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $root '.env.example') $envFile }
if ((Get-Content $envFile -Raw) -notmatch '\n$') { Add-Content $envFile '' }
$have = (Get-Content $envFile | ForEach-Object { ($_ -split '=', 2)[0] })
foreach ($line in Get-Content (Join-Path $root '.env.example')) {
    if ($line -match '^[A-Za-z_]+=' -and ($have -notcontains ($line -split '=', 2)[0])) { Add-Content $envFile $line }
}

