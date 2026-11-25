$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
# Only the agentcrash database is created; other databases are never touched.
$exists = psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$Db'"
if ($LASTEXITCODE -ne 0) { throw 'cannot reach PostgreSQL on localhost:5432' }
if (-not $exists) {
    psql -d postgres -c "CREATE DATABASE $Db"
    if ($LASTEXITCODE -ne 0) { throw 'create database failed' }
}
Write-Host "postgres ok, database $Db ready"
# Background services (gateway, mock servers, runtime) are added in later prompts;
# their PIDs are recorded in .run/*.pid so `just down` can stop them.