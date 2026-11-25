$ErrorActionPreference = 'Stop'
uv --project "$PSScriptRoot/../verifier" run python -m agentcrash_verifier stack down
Write-Host 'background processes stopped (PostgreSQL left running)'