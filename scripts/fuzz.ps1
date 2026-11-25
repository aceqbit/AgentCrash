param([int]$N = 500, [string]$Seed = 'random')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
& "$PSScriptRoot/migrate.ps1"
& "$PSScriptRoot/build.ps1"
$a = @('--project', "$PSScriptRoot/../verifier", 'run', 'python', '-m', 'agentcrash_verifier', 'fuzz', '--n', $N)
if ($Seed -ne 'random') { $a += @('--seed', $Seed) }
uv @a
exit $LASTEXITCODE

