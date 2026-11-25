import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { TestStack } from "./stack.js";
import { resetDb } from "./helpers.js";
import { startRig, type AuthRig } from "./auth-harness.js";

const stack = new TestStack();
let rig: AuthRig;

beforeAll(async () => {
  await resetDb();
  await stack.startMock();
  rig = await startRig(`${stack.mockUrl}/mcp`);
});
afterAll(async () => {
  await rig.close();
  await stack.stop();
});

async function newRun(): Promise<string> {
  const id = randomUUID();
  await rig.gw.app.inject({ method: "POST", url: "/v1/runs", payload: { scenario: "auth", run_id: id } });
  return id;
}
const call = (runId: string, token: string | undefined, tool = "transfer", args: object = { from: "A", to: "B", amount: 10 }) =>
  rig.gw.app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/steps/0/call`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { tool, args },
  });

describe("OAuth 2.0 client credentials and per-tool scopes", () => {
  it("a token without tool:transfer gets 403 and no journal row reaches SENT", async () => {
    const run = await newRun();
    const token = await rig.token("agent-readonly");
    const res = await call(run, token);
    expect(res.statusCode).toBe(403);
    const { rows } = await rig.gw.pool.query("SELECT state FROM tool_calls WHERE run_id = $1", [run]);
    expect(rows).toHaveLength(0);
    expect(await stack.effects()).toHaveLength(0);
  });

  it("a token with tool:transfer is accepted and the effect happens once", async () => {
    const run = await newRun();
    const token = await rig.token("agent-runtime");
    expect((await call(run, token)).statusCode).toBe(200);
    expect((await stack.effects()).filter((e) => e.tool === "transfer")).toHaveLength(1);
  });

  it("the token endpoint issues short-lived tokens limited to the client's scopes", async () => {
    const r = await fetch(`${rig.authUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "agent-readonly", client_secret: "ro" }),
    });
    const j = (await r.json()) as { expires_in: number; scope: string };
    expect(j.expires_in).toBeLessThanOrEqual(600);
    expect(j.scope.split(" ").sort()).toEqual(["tool:get_balance", "tool:list_sent_emails"]);
  });

  it("serves the JWKS with an ES256 public key only", async () => {
    const jwks = (await (await fetch(`${rig.authUrl}/jwks.json`)).json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys[0]?.alg).toBe("ES256");
    expect(jwks.keys[0]?.d).toBeUndefined();
  });

  it("records an auth.denied span with the required scope", async () => {
    const run = await newRun();
    await call(run, await rig.token("agent-readonly"));
    rig.gw.tracing.flush();
    const spans = (await import("./helpers.js")).readSpans(rig.cfg.tracesFile);
    const denied = spans.find((s) => s.name === "auth.denied" && s.trace_id === run.replace(/-/g, ""));
    expect(denied).toBeTruthy();
    expect(JSON.stringify(denied)).toContain("tool:transfer");
  });
});
