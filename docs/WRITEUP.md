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
