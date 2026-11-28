# CI proof

The CI gate must fail when the idempotency key is removed, and pass otherwise.

| Run | Branch | Result | URL |
|---|---|---|---|
| Passing | `main` (unit tests fixed for Node 20, commit `9a5f324`) | lint, unit, integration and the 20-point sweep all succeeded | https://github.com/aceqbit/AgentCrash/actions/runs/45660544227 |
| Failing | `demo/remove-key` (commit `1f7194a`) | lint and unit tests succeeded; the integration job failed | https://github.com/aceqbit/AgentCrash/actions/runs/45663077617 |

`demo/remove-key` changes one line in `gateway/src/mcp.ts` so the gateway no longer sends `params._meta["agentcrash/idempotency_key"]` to the MCP server. The mock server then cannot deduplicate a resend, the crash-point integration tests see a duplicate effect, and the job fails. The branch is kept on the remote only; it is never merged.

An earlier run of the same branch failed in the lint step because the unused parameter tripped ESLint, which says nothing about the gate; the branch was rewritten so that lint and the unit tests pass and only the crash tests fail.
