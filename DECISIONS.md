# DECISIONS

Dependencies outside CLAUDE.md section 3, and environment substitutions, are recorded here before use.

## D1: Windows-native toolchain (2026-11-25)
No Docker, Compose, WSL or Make. `just` replaces `make` (justfile uses PowerShell); scripts are PowerShell or Python. PostgreSQL 18 on localhost:5432 replaces the Compose `postgres:16` service; only the `agentcrash` database is created. CLAUDE.md names PostgreSQL 16; schema uses nothing version-specific.

## D2: Tracing without Collector/Jaeger
Spans go to the console and `results/traces.jsonl`. "Visible in Jaeger" means present in that file.

## D3: In-repo OAuth 2.0 token endpoint instead of Keycloak (Phase 2)
Client-credentials grant, JWKS endpoint, one scope per tool (`tool:<name>`). Cloud/Terraform work (prompts 2.6, 2.7) skipped.

## D4: Dev tooling beyond section 3
`typescript`, `eslint`, `typescript-eslint`, `@types/node`, `@types/pg` (TS tooling named by prompt 0), `ruff`, `mypy` (named by prompt 0).
## D5: Extra dependencies (2026-11-25)
- `pyyaml` (runtime, verifier): scenarios are YAML (CLAUDE.md section 9).
- `zod` (mock-servers, gateway): peer dependency of `@modelcontextprotocol/sdk` for tool input schemas.
- `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` (gateway): OpenTelemetry SDK for JS (section 3); spans are written by a small JSONL exporter instead of OTLP, see D2.
- Python OpenTelemetry is not used: the gateway emits all spans; the runtime does not (D2).
- `types-pyyaml` (dev): mypy stubs.
- Live model uses httpx against the Anthropic Messages API directly; no `anthropic` package.
