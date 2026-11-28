import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { TestStack, BANK_5, drive, waitHttp } from "./stack.js";
import { resetDb } from "./helpers.js";

const stack = new TestStack();
const J = { "content-type": "application/json" };

beforeAll(async () => {
  await resetDb();
  await stack.startMock();
});
afterAll(async () => {
  await stack.stop();
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${stack.gwUrl}${path}`, { method: "POST", headers: J, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function getRun(id: string): Promise<{ status: string; step_no: number; calls: { step_no: number; state: string }[] }> {
  return (await (await fetch(`${stack.gwUrl}/v1/runs/${id}`)).json()) as never;
}

describe("approval gate (bank_5 step 1)", () => {
  it("kill during AWAITING_APPROVAL, restart, approve: run finishes with one effect", async () => {
    const first = await stack.startGateway({ CRASH_AT: "1:P4_awaiting_approval" });
    const runId = randomUUID();
    await post("/v1/runs", { scenario: "bank_5", run_id: runId });
    expect((await post(`/v1/runs/${runId}/steps/0/call`, BANK_5[0])).status).toBe(200);
    await post(`/v1/runs/${runId}/steps/1/call`, BANK_5[1]).catch(() => undefined);
    expect(await first.exited).not.toBe(0); // died by the hook
    expect(stack.crashMarker()?.point).toBe("P4_awaiting_approval");

    await stack.startGateway(); // restart without CRASH_AT; recovery scan runs
    await waitHttp(`${stack.gwUrl}/health`);
    await new Promise((r) => setTimeout(r, 500));
    let run = await getRun(runId);
    expect(run.status).toBe("WAITING_APPROVAL"); // survives the restart
    expect(run.calls.find((c) => c.step_no === 1)?.state).toBe("AWAITING_APPROVAL");
    expect((await stack.effects()).filter((e) => e.tool === "create_ticket")).toHaveLength(0); // nothing ran while waiting

    // Approval cannot change the args: a different call for the step is refused, key unchanged.
    const tampered = await post(`/v1/runs/${runId}/steps/1/call`, { ...BANK_5[1], args: { title: "Other" } });
    expect(tampered.status).toBe(409);

    expect((await post(`/v1/runs/${runId}/approve`, { step_no: 1 })).body).toEqual({ approved: [1] });
    expect(await drive(stack.gwUrl, runId, BANK_5, { autoApprove: false })).toBe("DONE");
    run = await getRun(runId);
    expect(run.step_no).toBe(run.calls.filter((c) => c.state === "DONE").length);
    expect((await stack.effects()).filter((e) => e.tool === "create_ticket")).toHaveLength(1);
  });

  it("reject marks the call and the run FAILED and nothing is executed", async () => {
    await fetch(`${stack.mockUrl}/_reset`, { method: "POST" });
    const runId = randomUUID();
    await post("/v1/runs", { scenario: "bank_5", run_id: runId });
    await post(`/v1/runs/${runId}/steps/0/call`, BANK_5[0]);
    expect((await post(`/v1/runs/${runId}/steps/1/call`, BANK_5[1])).body.state).toBe("AWAITING_APPROVAL");
    expect((await post(`/v1/runs/${runId}/reject`, { step_no: 1 })).body).toEqual({ rejected: [1] });
    expect((await post(`/v1/runs/${runId}/steps/1/call`, BANK_5[1])).status).toBe(410);
    expect((await getRun(runId)).status).toBe("FAILED");
    expect((await stack.effects()).filter((e) => e.tool === "create_ticket")).toHaveLength(0);
  });
});
