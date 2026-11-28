$ErrorActionPreference = 'Stop'
$s = $PSScriptRoot
foreach ($step in 'lint', 'test', 'integration') {
    & "$s/$step.ps1"; if ($LASTEXITCODE) { Write-Host "check failed at $step"; exit 1 }
}
# 20-point sweep (CLAUDE.md section 12)
& "$s/sweep.ps1" -Scenario bank_5; if ($LASTEXITCODE) { Write-Host 'check failed at sweep'; exit 1 }
Write-Host 'check passed'
