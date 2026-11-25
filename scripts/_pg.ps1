# Shared helper: puts psql on PATH and sets connection env (dot-source this).
$pgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object { [int]$_.Directory.Parent.Name } -Descending | Select-Object -First 1).DirectoryName
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { $env:Path += ";$pgBin" }
if (-not $env:PGHOST) { $env:PGHOST = 'localhost' }
if (-not $env:PGPORT) { $env:PGPORT = '5432' }
if (-not $env:PGUSER) { $env:PGUSER = 'postgres' }
if (-not $env:PGPASSWORD) { $env:PGPASSWORD = 'postgres' }
$script:Db = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'agentcrash' }
