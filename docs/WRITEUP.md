# AgentCrash write-up

## Problem

An agent calls tools through a loop. If the process dies between "the tool did its work" and "the agent knows it did", a restart has two bad options: call again and risk a duplicate effect, or skip and risk a lost one. AgentCrash makes that boundary explicit and tests it by killing the process at every point where it matters.

## Design

A gateway sits between the agent runtime and the MCP tool servers. Every call is journaled in PostgreSQL before it is sent, carries an idempotency key, and is finished in one transaction that also advances the run's step counter.

- The key is the SHA-256 of run id, step number, tool and canonical JSON arguments, so a repeated call always maps to the same journal row.
- A call moves through `PLANNED`, `AWAITING_APPROVAL`, `SENT`, `DONE`, `UNKNOWN` and `FAILED`. The recovery table in `CLAUDE.md` section 6 decides what happens to each state after a restart.
- An idempotent tool is resent with the same key and the server returns the stored result. A non-idempotent tool is reconciled with a read-only probe when one exists; otherwise the call becomes `UNKNOWN`, the run waits for an operator, and nothing is resent silently.
- Recovery takes a per-row advisory lock, so two gateway instances do not both recover the same call.
- Tool results are data. Nothing in a result can trigger another call, and the security tests check that.

## The four crash points

| Point | Moment | Outcome after restart |
|---|---|---|
| P1 | after the row is journaled as `PLANNED` | the call is executed once |
| P2 | after the server replied, before `DONE` is stored | an idempotent call is deduplicated by the server; a non-idempotent call is reconciled or surfaced as `UNKNOWN` |
| P3 | after `DONE` is committed, before the HTTP reply | the repeated call returns the stored result |
| P4 | while waiting for approval | the wait survives the restart |

## How it is verified

The verifier starts the stack, runs a scenario with a scripted model, kills the gateway at one `(step, point)`, restarts it, and compares the mock servers' own effect logs with the intended effects. It never uses the journal to decide pass or fail. The same procedure is run with a second kill during recovery, with a bypassed journal (which must produce duplicates, otherwise the verifier is broken), with randomly generated scenarios that shrink to a minimal failing case, and with many concurrent runs under repeated kills.

## Results

All tables below are generated from the files in `results/` by `scripts/report.py`; `scripts/verify_claims.py` checks that every number in this document and the README exists in a results file.

<!-- results:start -->

### Crash sweep (safe)

Source: `results/sweep_bank_5_20261125T160523Z.json` (git `e5a5d75120`).

| metric | value |
|---|---|
| points | 20 |
| duplicates | 0 |
| lost | 0 |
| unknown surfaced | 1 |
| recovery p50 (ms) | 2840 |
| recovery p95 (ms) | 3256 |
| recovery max (ms) | 3256 |

<details><summary>Every point</summary>

| step | point | crashed | dup | lost | unknown | pass |
|---|---|---|---|---|---|---|
| 0 | P1_after_planned | True | 0 | 0 | 0 | True |
| 0 | P2_after_exec | True | 0 | 0 | 0 | True |
| 0 | P3_after_commit | True | 0 | 0 | 0 | True |
| 0 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 1 | P1_after_planned | True | 0 | 0 | 0 | True |
| 1 | P2_after_exec | True | 0 | 0 | 0 | True |
| 1 | P3_after_commit | True | 0 | 0 | 0 | True |
| 1 | P4_awaiting_approval | True | 0 | 0 | 0 | True |
| 2 | P1_after_planned | True | 0 | 0 | 0 | True |
| 2 | P2_after_exec | True | 0 | 0 | 0 | True |
| 2 | P3_after_commit | True | 0 | 0 | 0 | True |
| 2 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 3 | P1_after_planned | True | 0 | 0 | 0 | True |
| 3 | P2_after_exec | True | 0 | 0 | 0 | True |
| 3 | P3_after_commit | True | 0 | 0 | 0 | True |
| 3 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 4 | P1_after_planned | True | 0 | 0 | 0 | True |
| 4 | P2_after_exec | True | 0 | 0 | 1 | True |
| 4 | P3_after_commit | True | 0 | 0 | 0 | True |
| 4 | P4_awaiting_approval | False | 0 | 0 | 0 | True |

</details>

### Crash sweep (second kill during recovery)

Source: `results/sweep_bank_5_double_20261125T163634Z.json` (git `424f53c6a0`).

| metric | value |
|---|---|
| points | 20 |
| duplicates | 0 |
| lost | 0 |
| unknown surfaced | 1 |
| recovery p50 (ms) | 8403 |
| recovery p95 (ms) | 13187 |
| recovery max (ms) | 13187 |

<details><summary>Every point</summary>

| step | point | crashed | dup | lost | unknown | pass |
|---|---|---|---|---|---|---|
| 0 | P1_after_planned | True | 0 | 0 | 0 | True |
| 0 | P2_after_exec | True | 0 | 0 | 0 | True |
| 0 | P3_after_commit | True | 0 | 0 | 0 | True |
| 0 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 1 | P1_after_planned | True | 0 | 0 | 0 | True |
| 1 | P2_after_exec | True | 0 | 0 | 0 | True |
| 1 | P3_after_commit | True | 0 | 0 | 0 | True |
| 1 | P4_awaiting_approval | True | 0 | 0 | 0 | True |
| 2 | P1_after_planned | True | 0 | 0 | 0 | True |
| 2 | P2_after_exec | True | 0 | 0 | 0 | True |
| 2 | P3_after_commit | True | 0 | 0 | 0 | True |
| 2 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 3 | P1_after_planned | True | 0 | 0 | 0 | True |
| 3 | P2_after_exec | True | 0 | 0 | 0 | True |
| 3 | P3_after_commit | True | 0 | 0 | 0 | True |
| 3 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 4 | P1_after_planned | True | 0 | 0 | 0 | True |
| 4 | P2_after_exec | True | 0 | 0 | 1 | True |
| 4 | P3_after_commit | True | 0 | 0 | 0 | True |
| 4 | P4_awaiting_approval | False | 0 | 0 | 0 | True |

</details>

### Crash sweep (unsafe mode, expected to fail)

Source: `results/sweep_bank_5_unsafe_20261125T160839Z.json` (git `e5a5d75120`).

| metric | value |
|---|---|
| points | 20 |
| duplicates | 10 |
| lost | 0 |
| unknown surfaced | 0 |
| recovery p50 (ms) | 2865 |
| recovery p95 (ms) | 8232 |
| recovery max (ms) | 8232 |

<details><summary>Every point</summary>

| step | point | crashed | dup | lost | unknown | pass |
|---|---|---|---|---|---|---|
| 0 | P1_after_planned | True | 0 | 0 | 0 | True |
| 0 | P2_after_exec | True | 1 | 0 | 0 | False |
| 0 | P3_after_commit | True | 1 | 0 | 0 | False |
| 0 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 1 | P1_after_planned | True | 0 | 0 | 0 | True |
| 1 | P2_after_exec | True | 1 | 0 | 0 | False |
| 1 | P3_after_commit | True | 1 | 0 | 0 | False |
| 1 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 2 | P1_after_planned | True | 0 | 0 | 0 | True |
| 2 | P2_after_exec | True | 1 | 0 | 0 | False |
| 2 | P3_after_commit | True | 1 | 0 | 0 | False |
| 2 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 3 | P1_after_planned | True | 0 | 0 | 0 | True |
| 3 | P2_after_exec | True | 1 | 0 | 0 | False |
| 3 | P3_after_commit | True | 1 | 0 | 0 | False |
| 3 | P4_awaiting_approval | False | 0 | 0 | 0 | True |
| 4 | P1_after_planned | True | 0 | 0 | 0 | True |
| 4 | P2_after_exec | True | 1 | 0 | 0 | False |
| 4 | P3_after_commit | True | 1 | 0 | 0 | False |
| 4 | P4_awaiting_approval | False | 0 | 0 | 0 | True |

</details>

### Security tests

Source: `results/security_20261125T184811Z.json`.

| metric | value |
|---|---|
| total | 51 |
| blocked | 51 |
| failed | 0 |

### Fuzz

Source: `results/fuzz_20261125T170212Z.json`.

| metric | value |
|---|---|
| scenarios | 500 |
| failures | 0 |
| seed | 1974991925 |
| max_recovery_ms | 15979 |

### Load

Source: `results/load_20261125T184150Z.json`.

| metric | value |
|---|---|
| runs | 50 |
| completed | 50 |
| waiting_unknown | 0 |
| kills | 5 |
| duplicates | 0 |
| lost | 0 |
| unknown | 0 |
| recovery_p50_ms | 772 |
| recovery_p95_ms | 1297 |
| recovery_max_ms | 3679 |

### Journal overhead

Source: `results/bench_20261125T185216Z.json` (git `b958482211`), 1000 calls per mode.

| run | journal p50 | journal p95 | passthrough p50 | passthrough p95 | overhead p50 | overhead p95 |
|---|---|---|---|---|---|---|
| before | 28.134 | 50.27 | 11.978 | 25.631 | 16.156 | 24.639 |
| after | 21.957 | 32.112 | 9.907 | 17.473 | 12.05 | 14.639 |

<!-- results:end -->

## Limits

- A server that reports success without acting is not covered.
- PostgreSQL disk corruption is not covered.
- An effect that cannot be reconciled, such as an email already sent by a tool with no probe, ends as `UNKNOWN` and waits for an operator.
- Only the gateway process is killed. Killing PostgreSQL or a mock server is not part of the sweep.
- The mock servers are written for this project; no real third-party system was tested.
- Effects are not undone. There is no saga compensation.
- The measurements come from one Windows machine with a local PostgreSQL; they say nothing about other hardware.

## Prior art

Temporal, DBOS and Restate provide durable execution for general workflows. Atomix, Robust Agent Compensation and ChronoMCP are related work on making agent tool use reliable. This project does not compare against any of them and states no measurement about them. The differentiator is narrow: a small journal at the MCP tool-call boundary together with a verifier that kills the process at every boundary and checks the effect logs of independent servers.
