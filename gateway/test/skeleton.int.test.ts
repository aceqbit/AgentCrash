import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGateway, type Gateway } from "../src/app.js";
import { resetDb, testConfig, readSpans } from "./helpers.js";

let gw: Gateway;
const cfg = testConfig();

beforeAll(async () => {
  await resetDb();
  gw = await buildGateway(cfg, { mcp: { call: async () => ({ ok: true }), close: async () => undefined } });
});
afterAll(async () => {
  await gw.close();
});

describe("gateway skeleton", () => {
  it("creates a run and serves it", async () => {
    const res = await gw.app.inject({ method: "POST", url: "/v1/runs", payload: { scenario: "bank_5" } });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    const get = await gw.app.inject({ method: "GET", url: `/v1/runs/${run.run_id}` });
    expect(get.json().status).toBe("RUNNING");
  });

  it("two concurrent identical calls produce one journal row", async () => {
    const run = (await gw.app.inject({ method: "POST", url: "/v1/runs", payload: { scenario: "x" } })).json();
    const call = () =>
      gw.app.inject({
        method: "POST",
        url: `/v1/runs/${run.run_id}/steps/0/call`,
        payload: { tool: "transfer", args: { from: "A", to: "B", amount: 10 } },
      });
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const { rows } = await gw.pool.query("SELECT count(*)::int AS n FROM tool_calls WHERE run_id = $1", [run.run_id]);
    expect(rows[0].n).toBe(1);
  });

  it("rejects a different call for an already journaled step", async () => {
    const run = (await gw.app.inject({ method: "POST", url: "/v1/runs", payload: { scenario: "x" } })).json();
    const url = `/v1/runs/${run.run_id}/steps/0/call`;
    await gw.app.inject({ method: "POST", url, payload: { tool: "transfer", args: { amount: 1 } } });
    const res = await gw.app.inject({ method: "POST", url, payload: { tool: "transfer", args: { amount: 2 } } });
    expect(res.statusCode).toBe(409);
  });

  it("emits run, step.<n> and journal.plan spans sharing the run trace", async () => {
    const run = (await gw.app.inject({ method: "POST", url: "/v1/runs", payload: { scenario: "x" } })).json();
    await gw.app.inject({
      method: "POST",
      url: `/v1/runs/${run.run_id}/steps/0/call`,
      payload: { tool: "create_ticket", args: { title: "t" } },
    });
    const traceId = (run.run_id as string).replace(/-/g, "");
    const spans = readSpans(cfg.tracesFile).filter((s) => s.trace_id === traceId);
    const by = (n: string) => spans.find((s) => s.name === n);
    expect(by("run")).toBeTruthy();
    expect(by("step.0")?.parent_span_id).toBe(by("run")?.span_id);
    expect(by("journal.plan")?.parent_span_id).toBe(by("step.0")?.span_id);
  });
});