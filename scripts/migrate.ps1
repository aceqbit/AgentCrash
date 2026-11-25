$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
psql -d $Db -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
if ($LASTEXITCODE -ne 0) { throw 'cannot create schema_migrations' }
Get-ChildItem "$PSScriptRoot/../db/migrations" -Filter *.sql | Sort-Object Name | ForEach-Object {
    $n = $_.Name
    $done = psql -d $Db -tAc "SELECT 1 FROM schema_migrations WHERE name='$n'"
    if ($done) { Write-Host "skip  $n"; return }
    psql -d $Db -v ON_ERROR_STOP=1 -q -1 -f $_.FullName -c "INSERT INTO schema_migrations(name) VALUES ('$n')"
    if ($LASTEXITCODE -ne 0) { throw "migration $n failed" }
    Write-Host "apply $n"
}