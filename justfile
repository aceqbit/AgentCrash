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
    powershell -NoProfile -File scripts/integration.ps1

setup:
    powershell -NoProfile -File scripts/setup.ps1

build:
    powershell -NoProfile -File scripts/build.ps1

sweep SCENARIO="bank_5":
    powershell -NoProfile -File scripts/sweep.ps1 -Scenario {{SCENARIO}}

sweep-unsafe:
    powershell -NoProfile -File scripts/sweep.ps1 -Unsafe

fuzz N="500" SEED="":
    powershell -NoProfile -File scripts/fuzz.ps1 -N {{N}} -Seed '{{SEED}}'

demo:
    @Write-Host "not implemented"; exit 1

report:
    uv --project verifier run python scripts/report.py

check:
    powershell -NoProfile -File scripts/check.ps1


sweep-double SCENARIO="bank_5":
    powershell -NoProfile -File scripts/sweep.ps1 -Scenario {{SCENARIO}} -Double

