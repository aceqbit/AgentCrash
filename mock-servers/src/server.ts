import Fastify, { type FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, rmSync } from "node:fs";
import { join } from "node:path";

export const KEY_META = "agentcrash/idempotency_key";

export interface Effect {
  seq: number;
  tool: string;
  key: string | null;
  args: Record<string, unknown>;
  ts: string;
  result: unknown;
}

export interface MockOptions {
  dir: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

export function buildMock(opts: MockOptions): FastifyInstance {
  mkdirSync(opts.dir, { recursive: true });
  const effectsPath = join(opts.dir, "effects.jsonl");
  const dedupPath = join(opts.dir, "dedup_hits.jsonl");

  let effects: Effect[] = [];
  const byKey = new Map<string, Effect>();
  const balances = new Map<string, number>();
  let tickets = 0;

  const apply = (e: Effect): void => {
    if (e.tool === "transfer") {
      const a = e.args as { from: string; to: string; amount: number };
      balances.set(a.from, (balances.get(a.from) ?? 1000) - a.amount);
      balances.set(a.to, (balances.get(a.to) ?? 1000) + a.amount);
    } else if (e.tool === "create_ticket") {
      tickets += 1;
    }
  };

  const load = (): void => {
    effects = [];
    byKey.clear();
    balances.clear();
    tickets = 0;
    if (!existsSync(effectsPath)) return;
    for (const line of readFileSync(effectsPath, "utf8").split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line) as Effect;
      effects.push(e);
      if (e.key && (e.tool === "transfer" || e.tool === "create_ticket")) byKey.set(`${e.tool}:${e.key}`, e);
      apply(e);
    }
  };
  load();

  /** Append a line and fsync before returning (and so before any reply). */
  const appendDurable = (path: string, obj: unknown): void => {
    const fd = openSync(path, "a");
    try {
      writeSync(fd, JSON.stringify(obj) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const record = (tool: string, key: string | null, args: Record<string, unknown>, result: unknown): Effect => {
    const e: Effect = { seq: effects.length + 1, tool, key, args, ts: new Date().toISOString(), result };
    appendDurable(effectsPath, e);
    effects.push(e);
    apply(e);
    return e;
  };

  const keyOf = (extra: { _meta?: Record<string, unknown> }): string | null => {
    const k = extra._meta?.[KEY_META];
    return typeof k === "string" ? k : null;
  };

  const makeServer = (): McpServer => {
    const s = new McpServer({ name: "agentcrash-mock", version: "0.1.0" });

    const idempotent = (tool: "transfer" | "create_ticket", args: Record<string, unknown>, key: string | null, make: (seq: number) => unknown): ToolResult => {
      if (key) {
        const prev = byKey.get(`${tool}:${key}`);
        if (prev) {
          appendFileSync(dedupPath, JSON.stringify({ event: "dedup_hit", tool, key, ts: new Date().toISOString() }) + "\n");
          return text(prev.result);
        }
      }
      const seq = effects.length + 1;
      const e = record(tool, key, args, make(seq));
      if (key) byKey.set(`${tool}:${key}`, e);
      return text(e.result);
    };

    s.registerTool(
      "transfer",
      { description: "Move money between accounts (idempotent)", inputSchema: { from: z.string(), to: z.string(), amount: z.number() } },
      (args, extra) => idempotent("transfer", args, keyOf(extra), (seq) => ({ ok: true, tx_id: `tx-${seq}`, ...args })),
    );
    s.registerTool(
      "create_ticket",
      { description: "Create a ticket (idempotent)", inputSchema: { title: z.string() } },
      (args, extra) => idempotent("create_ticket", args, keyOf(extra), (seq) => ({ ok: true, ticket_id: `T-${seq}`, title: args.title })),
    );
    s.registerTool(
      "get_balance",
      { description: "Read an account balance (read-only)", inputSchema: { account: z.string() } },
      (args) => text({ account: args.account, balance: balances.get(args.account) ?? 1000 }),
    );
    s.registerTool(
      "send_email",
      { description: "Send an email (NOT idempotent)", inputSchema: { to: z.string(), subject: z.string() } },
      (args, extra) => text(record("send_email", keyOf(extra), args, { ok: true, message_id: `m-${effects.length + 1}` }).result),
    );
    s.registerTool(
      "list_sent_emails",
      { description: "Reconcile probe for send_email (read-only)", inputSchema: { key: z.string() } },
      (args) => {
        const found = effects.filter((e) => e.tool === "send_email" && e.key === args.key);
        return text({ found: found.length > 0, count: found.length, effect: found[0] ?? null });
      },
    );
    return s;
  };

  const app = Fastify({ logger: false });

  // Stateless streamable HTTP: a fresh server + transport per request.
  app.post("/mcp", async (req, reply) => {
    reply.hijack();
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  app.get("/_effects", async () => effects.map(({ seq, tool, key, args, ts }) => ({ seq, tool, key, args, ts })));
  app.get("/_dedup_hits", async () =>
    existsSync(dedupPath) ? readFileSync(dedupPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown) : [],
  );
  app.post("/_reset", async () => {
    // test-only
    rmSync(effectsPath, { force: true });
    rmSync(dedupPath, { force: true });
    load();
    return { ok: true };
  });
  app.get("/health", async () => ({ ok: true }));
  return app;
}