set shell := ["powershell.exe", "-NoProfile", "-Command"]

default:
    @just --list

up:
    powershell -NoProfile -File scripts/up.ps1

down:
    powershell -NoProfile -File scripts/down.ps1

migrate:
    powershell -NoProfile -File scripts/migrate.ps1

lint:
    powershell -NoProfile -File scripts/lint.ps1

test:
    powershell -NoProfile -File scripts/test.ps1

integration:
    @Write-Host "not implemented"; exit 1

sweep SCENARIO="bank_5":
    @Write-Host "not implemented"; exit 1

sweep-unsafe:
    @Write-Host "not implemented"; exit 1

fuzz N="500":
    @Write-Host "not implemented"; exit 1

demo:
    @Write-Host "not implemented"; exit 1

report:
    @Write-Host "not implemented"; exit 1

check:
    @Write-Host "not implemented"; exit 1