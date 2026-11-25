param([Parameter(Mandatory)][ValidateSet('before', 'after', 'merge')][string]$Label, [int]$Calls = 1000)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_pg.ps1"
& "$PSScriptRoot/migrate.ps1"
& "$PSScriptRoot/build.ps1"
uv --project "$PSScriptRoot/../verifier" run python -m agentcrash_verifier bench $Label --calls $Calls
exit $LASTEXITCODE
