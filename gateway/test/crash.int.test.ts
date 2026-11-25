import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { TestStack, BANK_5, drive, waitHttp } from "./stack.js";
import { DB_URL, resetDb } from "./helpers.js";

const stack = new TestStack();
const pool = new pg.Pool({ connectionString: DB_URL });

beforeAll(async () => {
  await resetDb();
  await stack.startMock();
});
afterEach(async () => {
  stack.gw?.child.kill();
  await stack.gw?.exited;
});
afterAll(async () => {
  await stack.stop();
  await pool.end();
});

const POINTS = ["P1_after_planned", "P2_after_exec", "P3_after_commit", "P4_awaiting_approval"] as const;

async function newRun(): Promise<string> {
  const id = randomUUID();
  await fetch(`${stack.gwUrl}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "bank_5", run_id: id }) });
  return id;
}

/** Crash the gateway at (step, point), restart it, finish the run. Returns the run id and the end state. */
async function crashAndRecover(step: number, point: string): Promise<{ runId: string; end: string; fired: boolean }> {
  await fetch(`${stack.mockUrl}/_reset`, { method: "POST" });
  await resetDb();
  const first = await stack.startGateway({ CRASH_AT: `${step}:${point}` });
  const runId = await newRun();
  const driving = drive(stack.gwUrl, runId, BANK_5, { timeoutMs: 40000 });
  const code = await Promise.race([first.exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 8000))]);
  const fired = code !== "alive";
  if (fired) await stack.startGateway(); // restart without CRASH_AT; the driver keeps retrying
  const end = await driving;
  await waitHttp(`${stack.gwUrl}/health`);
  return { runId, end, fired };
}

describe.each([0, 2, 4])("crash at step %i (bank_5)", (step) => {
  it.each(POINTS)("%s: E1 to E4 hold", async (point) => {
    const { runId, end, fired } = await crashAndRecover(step, point);
    if (point === "P4_awaiting_approval" && step !== 1) {
      expect(fired).toBe(false); // only step 1 has an approval gate
    } else {
      expect(fired).toBe(true);
      expect(stack.crashMarker()?.point).toBe(point);
    }
    const effects = await stack.effects();
    const count = (tool: string, key?: string): number => effects.filter((e) => e.tool === tool && (!key || e.key === key)).length;
    const uncertain = step === 4 && point === "P2_after_exec"; // non-idempotent, no probe
    // E1/E2: each intended effect exactly once (E3: the uncertain call is never resent).
    expect(count("transfer")).toBe(2);
    expect(count("create_ticket")).toBe(1);
    expect(count("send_email")).toBe(2); // steps 2 and 4, once each (uncertain step 4 is not resent)
    const run = (await (await fetch(`${stack.gwUrl}/v1/runs/${runId}`)).json()) as {
      status: string;
      step_no: number;
      calls: { state: string }[];
    };
    if (uncertain) {
      expect(end).toBe("UNKNOWN"); // E3
      expect(run.status).toBe("WAITING_APPROVAL");
      expect(run.calls.filter((c) => c.state === "UNKNOWN").length).toBe(1);
    } else {
      expect(end).toBe("DONE");
    }
    // E4: step_no equals the number of DONE rows.
    expect(run.step_no).toBe(run.calls.filter((c) => c.state === "DONE").length);
  });
});