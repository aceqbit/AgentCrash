param([string]$Scenario = 'bank_5', [switch]$Unsafe, [switch]$Double)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
& "$PSScriptRoot/migrate.ps1"
& "$PSScriptRoot/build.ps1"
$a = @('--project', "$PSScriptRoot/../verifier", 'run', 'python', '-m', 'agentcrash_verifier', 'sweep', '--scenario', $Scenario)
if ($Unsafe) { $a += '--unsafe' }
if ($Double) { $a += '--double' }
uv @a
exit $LASTEXITCODE

