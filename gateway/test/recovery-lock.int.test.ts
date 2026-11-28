import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { TestStack } from "./stack.js";
import { DB_URL, resetDb } from "./helpers.js";

const stack = new TestStack();
const pool = new pg.Pool({ connectionString: DB_URL });

beforeAll(async () => {
  await resetDb();
  await stack.startMock();
});
afterAll(async () => {
  await stack.stop();
  await pool.end();
});

describe("two gateway instances recover the same row", () => {
  it("a PLANNED non-idempotent call is executed by exactly one of them", async () => {
    const first = await stack.startGateway({ CRASH_AT: "0:P1_after_planned" });
    const runId = randomUUID();
    const J = { "content-type": "application/json" };
    await fetch(`${stack.gwUrl}/v1/runs`, { method: "POST", headers: J, body: JSON.stringify({ scenario: "lock", run_id: runId }) });
    await fetch(`${stack.gwUrl}/v1/runs/${runId}/steps/0/call`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ tool: "send_email", args: { to: "ops@example.test", subject: "once" }, probe: "list_sent_emails" }),
    }).catch(() => undefined);
    await first.exited;
    const { rows } = await pool.query("SELECT state FROM tool_calls WHERE run_id = $1", [runId]);
    expect(rows[0].state).toBe("PLANNED");

    // Both instances run their startup recovery scan against the same row at the same time.
    await Promise.all([stack.startExtraGateway(), stack.startExtraGateway()]);
    await new Promise((r) => setTimeout(r, 2500));
    const emails = (await stack.effects()).filter((e) => e.tool === "send_email");
    expect(emails).toHaveLength(1);
    const after = await pool.query("SELECT state, attempts FROM tool_calls WHERE run_id = $1", [runId]);
    expect(after.rows[0]).toEqual({ state: "DONE", attempts: 1 });
  });
});
