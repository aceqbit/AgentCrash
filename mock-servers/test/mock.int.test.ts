import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildMock, KEY_META } from "../src/server.js";

let app: FastifyInstance;
let url: string;
let dir: string;
const startMock = async (): Promise<void> => {
  app = buildMock({ dir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mock-"));
  await startMock();
});
afterAll(async () => {
  await app.close();
});

async function call(name: string, args: Record<string, unknown>, key?: string): Promise<unknown> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  try {
    const res = await client.callTool({ name, arguments: args, _meta: key ? { [KEY_META]: key } : undefined });
    const c = res.content as { text: string }[];
    return JSON.parse(c[0]?.text ?? "null");
  } finally {
    await client.close();
  }
}
const effects = async (): Promise<Array<{ tool: string; key: string | null }>> =>
  (await fetch(`${url}/_effects`)).json() as Promise<Array<{ tool: string; key: string | null }>>;

describe("mock MCP server", () => {
  it("lists the five tools", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    expect(names).toEqual(["create_ticket", "get_balance", "list_sent_emails", "send_email", "transfer"]);
  });

  it("a repeated key gives one effect and one dedup_hit, same result", async () => {
    await fetch(`${url}/_reset`, { method: "POST" });
    const a = await call("transfer", { from: "A", to: "B", amount: 10 }, "k1");
    const b = await call("transfer", { from: "A", to: "B", amount: 10 }, "k1");
    expect(b).toEqual(a);
    expect((await effects()).length).toBe(1);
    const hits = (await (await fetch(`${url}/_dedup_hits`)).json()) as unknown[];
    expect(hits.length).toBe(1);
  });

  it("create_ticket dedups too; get_balance is never an effect", async () => {
    await fetch(`${url}/_reset`, { method: "POST" });
    await call("create_ticket", { title: "x" }, "t1");
    await call("create_ticket", { title: "x" }, "t1");
    await call("get_balance", { account: "A" });
    expect((await effects()).map((e) => e.tool)).toEqual(["create_ticket"]);
  });

  it("send_email executes every time", async () => {
    await fetch(`${url}/_reset`, { method: "POST" });
    await call("send_email", { to: "a@x.test", subject: "s" }, "e1");
    await call("send_email", { to: "a@x.test", subject: "s" }, "e1");
    expect((await effects()).filter((e) => e.tool === "send_email").length).toBe(2);
  });

  it("list_sent_emails(key) finds the effect and nothing for an unknown key", async () => {
    await fetch(`${url}/_reset`, { method: "POST" });
    await call("send_email", { to: "a@x.test", subject: "s" }, "e2");
    expect(((await call("list_sent_emails", { key: "e2" })) as { found: boolean }).found).toBe(true);
    expect(((await call("list_sent_emails", { key: "nope" })) as { found: boolean }).found).toBe(false);
  });

  it("keeps its log across a server restart and dedups on the old key", async () => {
    await fetch(`${url}/_reset`, { method: "POST" });
    await call("transfer", { from: "A", to: "B", amount: 5 }, "k9");
    await app.close();
    await startMock();
    await call("transfer", { from: "A", to: "B", amount: 5 }, "k9");
    expect((await effects()).length).toBe(1);
    expect(readFileSync(join(dir, "effects.jsonl"), "utf8").trim().split("\n").length).toBe(1);
  });
});