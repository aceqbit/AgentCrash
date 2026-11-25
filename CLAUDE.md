# CLAUDE.md: AgentCrash

Save this file as `CLAUDE.md` in the repo root. Read it fully at the start of every session.

## 1. What this project is

AgentCrash is a durable MCP agent runtime plus a crash-point verifier.

- A TypeScript **tool gateway** sits between an agent and MCP tool servers. It journals every tool call in PostgreSQL, sends an idempotency key with each call, and recovers after a crash.
- A Python **runtime** (LangGraph loop, FastAPI) calls tools only through the gateway.
- A Python **verifier** kills the process at every tool-call boundary, restarts it, and compares the effects recorded by independent mock MCP servers with a clean run.

Goal: prove, with a CI gate, that after any single crash an idempotent tool's effect happens exactly once, and that every uncertain call on a non-idempotent tool is surfaced as `UNKNOWN`, never silently retried.

Non-goals: a general workflow engine, a UI (until Phase 2 improvements), supporting real third-party systems, undoing effects (saga compensation is a later improvement).

## 2. Rules for you (Claude Code)

1. Never invent a number. Every metric in the README, docs or commit messages must come from a file in `results/` written by code in this repo.
2. Do not add a dependency that is not in section 3 without writing the reason in `DECISIONS.md` first.
3. List a technology in the README only if it is used in the code.
4. Write the failing test first for every invariant in section 8, then the code.
5. If the spec is ambiguous or blocked, take the safest choice, record it in `OPEN_QUESTIONS.md`, and continue. Do not stop to ask unless a decision cannot be undone.
6. Run `make check` before saying a task is done. Paste the last 20 lines of its output.
7. Small commits, one concern each, imperative subject line. No secrets in the repo; use `.env.example`.
8. The verifier must never trust the journal. Ground truth is the mock servers' own effect logs.

## 3. Stack (pin versions in lock files)

| Part | Choice |
|---|---|
| Runtime | Python 3.12, FastAPI, asyncio, httpx, psycopg 3, `langgraph`, `langgraph-checkpoint-postgres` |
| Gateway and mock servers | Node 20 or newer, TypeScript (strict), Fastify, `pg`, official `@modelcontextprotocol/sdk` |
| Journal | PostgreSQL 16 |
| Tests | pytest, hypothesis (Python); vitest (TypeScript) |
| Tracing | OpenTelemetry SDKs (Python and JS), OTel Collector, Jaeger |
| Auth (Phase 2) | Keycloak, `jose` for JWT verification |
| Packaging | Docker, Docker Compose, GitHub Actions |
| Cloud (Phase 2) | Terraform, AWS ECS Fargate, RDS, ECR, Secrets Manager; GCP Cloud Run variant |

Before coding against the MCP TypeScript SDK, read its current README for the client and server API and the HTTP transport. Do not rely on memory.

## 4. Repo layout

```
agentcrash/
  CLAUDE.md  PROMPTS.md  DECISIONS.md  OPEN_QUESTIONS.md  README.md  Makefile
  docker-compose.yml  .env.example
  gateway/            # TypeScript: journal, recovery, MCP client, scopes
    src/ test/
  mock-servers/       # TypeScript MCP servers with independent effect logs
    src/ test/
  runtime/            # Python: FastAPI run API, LangGraph loop, scripted model
    src/agentcrash_runtime/ tests/
  verifier/           # Python: scenarios, crash injector, oracle, report
    src/agentcrash_verifier/ tests/ scenarios/*.yaml
  db/migrations/      # plain .sql, numbered
  infra/              # terraform/aws, terraform/gcp (Phase 2)
  results/            # generated JSON, committed only for released runs
  docs/
```

## 5. Data model

```sql
CREATE TABLE runs (
  run_id     uuid PRIMARY KEY,
  scenario   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('RUNNING','WAITING_APPROVAL','DONE','FAILED')),
  step_no    int  NOT NULL DEFAULT 0,        -- next step to execute
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tool_calls (
  idempotency_key text PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES runs(run_id),
  step_no    int  NOT NULL,
  tool       text NOT NULL,
  args       jsonb NOT NULL,
  state      text NOT NULL CHECK (state IN
             ('PLANNED','AWAITING_APPROVAL','SENT','DONE','UNKNOWN','FAILED')),
  result     jsonb,
  attempts   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_no)
);
CREATE INDEX tool_calls_state_idx ON tool_calls (state) WHERE state IN ('PLANNED','SENT','AWAITING_APPROVAL');
```

Idempotency key: `sha256(run_id || ":" || step_no || ":" || tool || ":" || canonical_json(args))`, hex. Canonical JSON means sorted keys, no whitespace, UTF-8.

## 6. Call protocol (gateway)

`POST /v1/runs/{run_id}/steps/{step_no}/call` with `{tool, args}`. The call is idempotent: the same input always returns the same journaled outcome.

1. Compute the key. In one transaction, `INSERT ... ON CONFLICT DO NOTHING` the row as `PLANNED`, then read the row back. If the row is already `DONE`, return its result.  **Crash point P1** fires after this commit.
2. Check the token scope for `tool` (Phase 2). If the tool requires approval, set `AWAITING_APPROVAL`, set run `WAITING_APPROVAL`, return `202`.  **Crash point P4** fires while waiting.
3. Set `SENT`, `attempts = attempts + 1`, commit. Call the MCP server with the key in `params._meta["agentcrash/idempotency_key"]`.  **Crash point P2** fires after the server returns and before step 4.
4. One transaction: set the row `DONE` with `result`, and `UPDATE runs SET step_no = step_no + 1 WHERE run_id = $1 AND step_no = $2`. Commit.  **Crash point P3** fires after this commit, before the HTTP response.
5. Return the result.

### Recovery on gateway start

Scan `tool_calls` where `state IN ('PLANNED','SENT','AWAITING_APPROVAL')` and the run is not terminal.

| State | Idempotent tool | Non-idempotent tool |
|---|---|---|
| `PLANNED` | Execute from step 3 | Execute from step 3 |
| `SENT` | Resend with the same key; server returns the stored result | If the tool declares a reconcile probe, call it with the key; effect found: store as `DONE`; not found: resend once; probe missing or inconclusive: set `UNKNOWN`, run `WAITING_APPROVAL` |
| `AWAITING_APPROVAL` | Keep waiting | Keep waiting |
| `DONE` | Nothing | Nothing |

Recovery is also triggered lazily: a repeated call for a step finds its row and applies the same table.

## 7. Mock MCP servers

Each server keeps its own append-only effect log in `effects.jsonl` and is never killed by the verifier.

| Tool | Idempotent | Behaviour |
|---|---|---|
| `transfer(from, to, amount)` | yes | Executes once per key; a repeated key returns the stored result and logs `dedup_hit` (not an effect) |
| `create_ticket(title)` | yes | Same |
| `get_balance(account)` | read-only | Safe to repeat; never logged as an effect |
| `send_email(to, subject)` | no | Executes every time it is called; no dedup |
| `list_sent_emails(key)` | read-only | Reconcile probe for `send_email`; returns the effect recorded under `key` or nothing |

Effect log line: `{"seq":n,"tool":"transfer","key":"...","args":{...},"ts":"..."}`. The oracle compares the multiset of `(tool, canonical_json(args))`.

## 8. Crash points and the `CRASH_AT` contract

Format: `CRASH_AT=<step_no>:<point>` with `<point>` in `P1_after_planned`, `P2_after_exec`, `P3_after_commit`, `P4_awaiting_approval`. Optional `CRASH_ON_RECOVERY=1` fires the hook again during recovery (Phase 2).

When the hook fires the process calls `process.kill(process.pid, 'SIGKILL')`. No cleanup, no flush. Hooks are compiled in only when `NODE_ENV !== 'production'` or `ALLOW_CRASH_HOOKS=1`.

### Invariants the tests and verifier enforce

- **E1** For idempotent tools, each intended effect appears exactly once in the server effect log after any single crash.
- **E2** No intended effect is missing after the run completes.
- **E3** Every call left uncertain on a non-idempotent tool ends as `UNKNOWN` and reaches `WAITING_APPROVAL`; none is resent silently.
- **E4** After recovery, `runs.step_no` equals the number of `DONE` rows for the run.
- **E5** The unsafe mode (`--no-journal`) produces at least one duplicate in a full sweep. If it does not, the verifier is broken.

## 9. Verifier

Scenario YAML:

```yaml
name: bank_5
seed: 7
steps:
  - {tool: transfer, args: {from: A, to: B, amount: 10}, idempotent: true}
  - {tool: create_ticket, args: {title: "Review transfer"}, idempotent: true}
  - {tool: send_email, args: {to: ops@example.test, subject: "Done"}, idempotent: false, probe: list_sent_emails}
```

Sweep procedure for each `(step, point)`:

1. Reset Postgres and mock servers; start the stack.
2. Start the run with `CRASH_AT=<step>:<point>`.
3. Wait for the gateway process to die; assert it died by `SIGKILL`.
4. Restart the gateway without `CRASH_AT`; let the run finish or reach `WAITING_APPROVAL`.
5. Read the mock effect logs; compare with the oracle recorded from a clean run of the same scenario.
6. Write one row to the report: `{step, point, duplicates, lost, unknown, recovery_ms, pass}`.

Report file: `results/sweep_<scenario>_<utc>.json` with `{scenario, git_sha, started, rows[], summary:{points, duplicates, lost, unknown, max_recovery_ms, p95_recovery_ms}}`.

CI gate: exit code 1 if any row has `duplicates > 0` for an idempotent tool, or `lost > 0`, or E3/E4 fail.

The model for all sweeps is a **scripted fake model** that returns the scenario's steps in order. A live LLM is used only in `make demo`.

## 10. Observability

OpenTelemetry. One trace per run, trace id derived from `run_id`. Span names: `run`, `step.<n>`, `journal.plan`, `journal.sent`, `mcp.call`, `journal.done`, `recovery.scan`, `recovery.resume`. Attributes: `run.id`, `step.no`, `tool`, `call.state`, `idempotency_key` (first 12 hex chars only), `crash.point` when set. A recovery produces a second span tree under the same run.

## 11. Security (Phase 2)

- Keycloak realm file in `infra/keycloak/realm.json`; clients use OAuth 2.0 client-credentials; one scope per tool, named `tool:<name>`.
- The gateway verifies the JWT signature with the JWKS, expiry, audience and scope on every call. Tokens live minutes, not hours.
- Tool results are data: the gateway never lets a result trigger another call. Negative tests must cover: missing scope, expired token, wrong audience, a result containing instructions to call another tool.
- Secrets only from environment or the cloud secret store.

## 12. Commands (Makefile)

`make up` · `make down` · `make migrate` · `make test` (unit, both languages) · `make integration` · `make sweep SCENARIO=bank_5` · `make sweep-unsafe` · `make fuzz` (Hypothesis) · `make lint` · `make check` (lint + test + integration + a 20-point sweep) · `make demo` · `make report` (regenerates README tables from `results/`).

## 13. Definition of done

**Phase 1:** `make check` passes; `make sweep SCENARIO=bank_5` reports 20 points with 0 duplicates and 0 lost; `make sweep-unsafe` reports duplicates; a pull request that removes the idempotency key fails CI; trace of a run visible in Jaeger.

**Phase 2:** negative security tests pass; double-crash sweep passes; `make fuzz` runs 500 random scenarios with shrinking; 50 concurrent runs with kills pass; Terraform applies and destroys cleanly on AWS; write-up in `docs/` quotes only numbers from `results/`.

## 14. Metrics to record (code writes them, you do not type them)

`results/` files with: points swept; duplicates; lost; unknown surfaced; journal overhead per call (p50, p95 ms, measured with and without the journal over 1,000 calls); recovery time (p50, p95, max ms); negative tests blocked (count); spans per call; line coverage (Python and TypeScript); concurrent runs survived. Targets are in the project plan; report whatever you measure.

## 15. Resume rules

Claim "built" and "verified". Never "first" or "novel". Do not describe a feature that is not in `main`. Numbers in resume bullets must match a file in `results/` and its git SHA.
