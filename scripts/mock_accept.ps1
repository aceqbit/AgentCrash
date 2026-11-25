# Accept script for prompt 1.2: call transfer twice with the same key against the built mock server.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
& "$PSScriptRoot/build.ps1"
$dir = Join-Path $root '.run/mock-accept'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
$env:MOCK_PORT = '7191'; $env:MOCK_DIR = $dir
$p = Start-Process node -ArgumentList "$root/mock-servers/dist/index.js" -PassThru -WindowStyle Hidden
try {
    for ($i = 0; $i -lt 50; $i++) { try { Invoke-RestMethod http://127.0.0.1:7191/health | Out-Null; break } catch { Start-Sleep -Milliseconds 100 } }
    $body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"transfer","arguments":{"from":"A","to":"B","amount":10},"_meta":{"agentcrash/idempotency_key":"accept-key"}}}'
    $h = @{ Accept = 'application/json, text/event-stream' }
    1..2 | ForEach-Object { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7191/mcp -Body $body -ContentType 'application/json' -Headers $h | Out-Null }
    Write-Host '--- effects.jsonl'; Get-Content "$dir/effects.jsonl"
    Write-Host '--- dedup_hits.jsonl'; Get-Content "$dir/dedup_hits.jsonl"
    $n = @(Get-Content "$dir/effects.jsonl").Count; $d = @(Get-Content "$dir/dedup_hits.jsonl").Count
    if ($n -ne 1 -or $d -ne 1) { throw "expected 1 effect and 1 dedup_hit, got $n and $d" }
    Write-Host 'OK: 1 effect, 1 dedup_hit'
} finally { Stop-Process -Id $p.Id -Force }