$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
# Only the agentcrash database is created; other databases are never touched.
$exists = psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$Db'"
if ($LASTEXITCODE -ne 0) { throw 'cannot reach PostgreSQL on localhost:5432' }
if (-not $exists) {
    psql -d postgres -c "CREATE DATABASE $Db"
    if ($LASTEXITCODE -ne 0) { throw 'create database failed' }
}
if (-not (Test-Path "$PSScriptRoot/../.env")) { Copy-Item "$PSScriptRoot/../.env.example" "$PSScriptRoot/../.env" }
& "$PSScriptRoot/migrate.ps1"
& "$PSScriptRoot/build.ps1"
if ($args -notcontains '-NoStack') {
    uv --project "$PSScriptRoot/../verifier" run python -m agentcrash_verifier stack up
    if ($LASTEXITCODE -ne 0) { throw 'stack failed to start' }
}