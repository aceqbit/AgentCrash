param([int]$Runs = 50, [int]$Kills = 5, [int]$Seed = 7)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
& "$PSScriptRoot/migrate.ps1"
& "$PSScriptRoot/build.ps1"
uv --project "$PSScriptRoot/../verifier" run python -m agentcrash_verifier load --runs $Runs --kills $Kills --seed $Seed
exit $LASTEXITCODE
