import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import type { Attributes, Context } from "@opentelemetry/api";
import { canonicalJson, idempotencyKey } from "./canonical.js";
import { createTracing, type Tracing } from "./tracing.js";
import { createMcpCaller, type McpCaller } from "./mcp.js";
import { createCrashHooks, type CrashHooks, type CrashPoint } from "./crash.js";
import { TOOLS } from "./tools.js";
import type { Config } from "./config.js";
import { createAuth, type Auth } from "./auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  idempotency_key: string;
  run_id: string;
  step_no: number;
  tool: string;
  args: Record<string, unknown>;
  state: "PLANNED" | "AWAITING_APPROVAL" | "SENT" | "DONE" | "UNKNOWN" | "FAILED";
  result: unknown;
  attempts: number;
  requires_approval: boolean;
  approved: boolean;
  probe: string | null;
}

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

export interface Gateway {
  app: FastifyInstance;
  pool: pg.Pool;
  tracing: Tracing;
  mcp: McpCaller;
  /** Resume every non-terminal call found in the journal (startup recovery). */
  recover(): Promise<void>;
  close(): Promise<void>;
}

export interface GatewayDeps {
  mcp?: McpCaller;
  hooks?: CrashHooks;
  auth?: Auth;
}

class UnexpectedState extends Error {}

/** Keys journaled by this process; anything else found in the journal predates a restart. */
const touched = new Set<string>();

export async function buildGateway(cfg: Config, deps: GatewayDeps = {}): Promise<Gateway> {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 60 });
  pool.on("error", (e) => console.error("pg pool error", e));
  const tracing = createTracing({ file: cfg.tracesFile, console: cfg.consoleSpans });
  const mcp = deps.mcp ?? createMcpCaller(cfg.mcpUrl);
  const hooks = deps.hooks ?? createCrashHooks(cfg.env);
  const auth = deps.auth ?? createAuth(cfg);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  const fire = (
    point: CrashPoint,
    run: string,
    step: number,
    recovering: boolean,
    ctx?: Context,
  ): void => {
    hooks.fire(point, step, recovering, () => tracing.instant(run, "crash", { "crash.point": point, "step.no": step }, ctx));
  };

  // ---- journal helpers (explicit transactions, no ORM) ---------------------------------

  async function setRunStatus(c: pg.PoolClient, runId: string, status: string): Promise<void> {
    await c.query("UPDATE runs SET status = $2, updated_at = now() WHERE run_id = $1 AND status IN ('RUNNING','WAITING_APPROVAL')", [
      runId,
      status,
    ]);
  }

  async function markState(c: pg.PoolClient, key: string, from: string[], to: string, runStatus?: string): Promise<void> {
    await c.query("BEGIN");
    try {
      const r = await c.query(
        "UPDATE tool_calls SET state = $2, updated_at = now() WHERE idempotency_key = $1 AND state = ANY($3) RETURNING run_id",
        [key, to, from],
      );
      if (r.rowCount === 1 && runStatus) await setRunStatus(c, r.rows[0].run_id as string, runStatus);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  }

  async function finishDone(c: pg.PoolClient, row: Row, result: unknown, ctx: Context): Promise<void> {
    await tracing.withSpan(
      row.run_id,
      "journal.done",
      { "step.no": row.step_no, tool: row.tool, "call.state": "DONE", idempotency_key: row.idempotency_key.slice(0, 12) },
      async () => {
        await c.query("BEGIN");
        try {
          const u = await c.query(
            "UPDATE tool_calls SET state = 'DONE', result = $2, updated_at = now() WHERE idempotency_key = $1 AND state IN ('SENT','PLANNED')",
            [row.idempotency_key, JSON.stringify(result)],
          );
          if (u.rowCount === 1) {
            await c.query("UPDATE runs SET step_no = step_no + 1, updated_at = now() WHERE run_id = $1 AND step_no = $2", [
              row.run_id,
              row.step_no,
            ]);
          }
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      },
      ctx,
    );
  }

  const spanAttrs = (row: Row, extra: Attributes = {}): Attributes => ({
    "step.no": row.step_no,
    tool: row.tool,
    "call.state": row.state,
    idempotency_key: row.idempotency_key.slice(0, 12),
    ...extra,
  });

  /** Protocol step 3 and 4: SENT, MCP call with the key, DONE + step_no advance. */
  async function execute(c: pg.PoolClient, row: Row, recovering: boolean, ctx: Context): Promise<Outcome> {
    await tracing.withSpan(
      row.run_id,
      "journal.sent",
      spanAttrs(row, { "call.state": "SENT" }),
      async () => {
        await c.query("UPDATE tool_calls SET state = 'SENT', attempts = attempts + 1, updated_at = now() WHERE idempotency_key = $1", [
          row.idempotency_key,
        ]);
      },
      ctx,
    );
    const result = await tracing.withSpan(
      row.run_id,
      "mcp.call",
      spanAttrs(row, { "call.state": "SENT" }),
      () => mcp.call(row.tool, row.args, row.idempotency_key),
      ctx,
    );
    fire("P2_after_exec", row.run_id, row.step_no, recovering, ctx);
    await finishDone(c, row, result, ctx);
    fire("P3_after_commit", row.run_id, row.step_no, recovering, ctx);
    return { status: 200, body: { state: "DONE", result } };
  }

  async function markUnknown(c: pg.PoolClient, row: Row): Promise<Outcome> {
    await markState(c, row.idempotency_key, ["SENT"], "UNKNOWN", "WAITING_APPROVAL");
    return { status: 202, body: { state: "UNKNOWN" } };
  }

  async function reconcile(c: pg.PoolClient, row: Row, recovering: boolean, ctx: Context): Promise<Outcome> {
    const info = TOOLS[row.tool];
    if (!info) throw new UnexpectedState(`unknown tool ${row.tool} in journal`);
    if (info.idempotent) return execute(c, row, recovering, ctx);
    if (!row.probe || row.probe !== info.probeTool) return markUnknown(c, row);
    let probe: { found?: boolean; effect?: { result?: unknown } | null };
    try {
      probe = (await tracing.withSpan(
        row.run_id,
        "mcp.call",
        spanAttrs(row, { probe: row.probe }),
        () => mcp.call(row.probe as string, { key: row.idempotency_key }),
        ctx,
      )) as typeof probe;
    } catch (e) {
      console.error(`probe failed for ${row.idempotency_key.slice(0, 12)}`, e);
      return markUnknown(c, row);
    }
    if (probe?.found === true) {
      await finishDone(c, row, probe.effect?.result ?? null, ctx);
      return { status: 200, body: { state: "DONE", result: probe.effect?.result ?? null } };
    }
    if (probe?.found === false) return execute(c, row, recovering, ctx); // not found: resend once
    return markUnknown(c, row); // inconclusive
  }

  /** Apply the recovery table to one row. Caller holds the row's advisory lock. */
  async function advance(c: pg.PoolClient, key: string, recovering: boolean, ctx: Context): Promise<Outcome> {
    const { rows } = await c.query<Row>("SELECT * FROM tool_calls WHERE idempotency_key = $1", [key]);
    const row = rows[0];
    if (!row) throw new UnexpectedState(`no row for key ${key.slice(0, 12)}`);
    switch (row.state) {
      case "DONE":
        fire("P3_after_commit", row.run_id, row.step_no, recovering, ctx);
        return { status: 200, body: { state: "DONE", result: row.result } };
      case "FAILED":
        return { status: 410, body: { state: "FAILED" } };
      case "UNKNOWN":
        return { status: 202, body: { state: "UNKNOWN" } };
      case "AWAITING_APPROVAL":
        fire("P4_awaiting_approval", row.run_id, row.step_no, recovering, ctx);
        return { status: 202, body: { state: "AWAITING_APPROVAL" } };
      case "PLANNED":
        if (row.requires_approval && !row.approved) {
          await markState(c, key, ["PLANNED"], "AWAITING_APPROVAL", "WAITING_APPROVAL");
          fire("P4_awaiting_approval", row.run_id, row.step_no, recovering, ctx);
          return { status: 202, body: { state: "AWAITING_APPROVAL" } };
        }
        return execute(c, row, recovering, ctx);
      case "SENT":
        return reconcile(c, row, recovering, ctx);
      default:
        throw new UnexpectedState(`unexpected state ${String(row.state)} for ${key.slice(0, 12)}`);
    }
  }

  async function withLock<T>(c: pg.PoolClient, key: string, blocking: boolean, fn: () => Promise<T>): Promise<T | undefined> {
    const q = blocking ? "SELECT pg_advisory_lock(hashtextextended($1, 0)), true AS ok" : "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok";
    const r = await c.query(q, [key]);
    if (!r.rows[0].ok) return undefined;
    try {
      return await fn();
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
    }
  }

  // ---- HTTP ----------------------------------------------------------------------------

  const reply502 = (reply: FastifyReply, e: unknown): FastifyReply => {
    console.error("call failed", e);
    return reply.code(502).send({ error: "tool call failed; journal left unchanged", detail: String(e) });
  };

  app.get("/health", async () => ({ ok: true, mode: cfg.mode }));

  app.post<{ Body: { scenario?: string; run_id?: string } }>("/v1/runs", async (req, reply) => {
    const scenario = req.body?.scenario;
    if (typeof scenario !== "string" || scenario.length === 0 || scenario.length > 100) {
      return reply.code(400).send({ error: "scenario required" });
    }
    const runId = req.body.run_id ?? randomUUID();
    if (!UUID_RE.test(runId)) return reply.code(400).send({ error: "bad run_id" });
    const ins = await pool.query(
      "INSERT INTO runs (run_id, scenario, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT DO NOTHING",
      [runId, scenario],
    );
    if (ins.rowCount === 1) tracing.runSpan(runId);
    const { rows } = await pool.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
    return reply.code(201).send(rows[0]);
  });

  app.get<{ Querystring: { status?: string } }>("/v1/runs", async (req) => {
    const st = (req.query.status ?? "RUNNING,WAITING_APPROVAL").split(",");
    const { rows } = await pool.query("SELECT * FROM runs WHERE status = ANY($1) ORDER BY created_at", [st]);
    return rows;
  });

  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
    const run = await pool.query("SELECT * FROM runs WHERE run_id = $1", [req.params.id]);
    if (run.rowCount === 0) return reply.code(404).send({ error: "no such run" });
    const calls = await pool.query(
      "SELECT step_no, tool, state, attempts, result FROM tool_calls WHERE run_id = $1 ORDER BY step_no",
      [req.params.id],
    );
    return { ...run.rows[0], calls: calls.rows };
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/v1/runs/:id/finish", async (req, reply) => {
    const status = req.body?.status === "FAILED" ? "FAILED" : "DONE";
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
    await pool.query("UPDATE runs SET status = $2, updated_at = now() WHERE run_id = $1 AND status IN ('RUNNING','WAITING_APPROVAL')", [
      req.params.id,
      status,
    ]);
    return { ok: true };
  });

  const decide = (action: "approve" | "reject") => async (req: FastifyRequest<{ Params: { id: string }; Body: { step_no?: number } | undefined }>, reply: FastifyReply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
    const denied = await auth.authorizeAdmin(req);
    if (denied) return reply.code(denied.status).send(denied.body);
    const step = req.body?.step_no;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const to = action === "approve" ? "PLANNED" : "FAILED";
      const r = await c.query(
        `UPDATE tool_calls SET state = $2, approved = approved OR $3, updated_at = now()
         WHERE run_id = $1 AND state IN ('AWAITING_APPROVAL','UNKNOWN') AND ($4::int IS NULL OR step_no = $4)
         RETURNING step_no`,
        [req.params.id, to, action === "approve", step ?? null],
      );
      if (action === "approve") {
        await c.query("UPDATE runs SET status = 'RUNNING', updated_at = now() WHERE run_id = $1 AND status = 'WAITING_APPROVAL'", [req.params.id]);
      } else if (r.rowCount) {
        await c.query("UPDATE runs SET status = 'FAILED', updated_at = now() WHERE run_id = $1 AND status IN ('RUNNING','WAITING_APPROVAL')", [req.params.id]);
      }
      await c.query("COMMIT");
      return { [action === "approve" ? "approved" : "rejected"]: r.rows.map((x) => x.step_no as number) };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  app.post<{ Params: { id: string }; Body: { step_no?: number } | undefined }>("/v1/runs/:id/approve", decide("approve"));
  app.post<{ Params: { id: string }; Body: { step_no?: number } | undefined }>("/v1/runs/:id/reject", decide("reject"));

  interface CallBody {
    tool?: string;
    args?: unknown;
    probe?: string | null;
    requires_approval?: boolean;
  }

  /** unsafe / passthrough: no journal. unsafe uses a random key per attempt, so a resume re-executes. */
  async function unjournaled(runId: string, stepNo: number, tool: string, args: Record<string, unknown>): Promise<Outcome> {
    const key = cfg.mode === "unsafe" ? randomBytes(32).toString("hex") : idempotencyKey(runId, stepNo, tool, args);
    fire("P1_after_planned", runId, stepNo, false);
    const result = await mcp.call(tool, args, key);
    fire("P2_after_exec", runId, stepNo, false);
    fire("P3_after_commit", runId, stepNo, false);
    return { status: 200, body: { state: "DONE", result } };
  }

  app.post<{ Params: { id: string; n: string }; Body: CallBody }>("/v1/runs/:id/steps/:n/call", async (req, reply) => {
    const runId = req.params.id;
    const stepNo = Number(req.params.n);
    if (!UUID_RE.test(runId) || !Number.isInteger(stepNo) || stepNo < 0 || stepNo > 100000) {
      return reply.code(400).send({ error: "bad run id or step" });
    }
    const { tool, args, probe, requires_approval } = req.body ?? {};
    if (typeof tool !== "string" || !Object.hasOwn(TOOLS, tool)) return reply.code(400).send({ error: "unknown tool" });
    if (args === null || typeof args !== "object" || Array.isArray(args)) return reply.code(400).send({ error: "args must be an object" });
    if (canonicalJson(args).length > cfg.maxArgsBytes) return reply.code(413).send({ error: "args too large" });
    const denied = await auth.authorizeCall(req, tool);
    if (denied) {
      tracing.instant(runId, "auth.denied", { tool, "auth.scope": `tool:${tool}`, reason: String(denied.body.error) });
      return reply.code(denied.status).send(denied.body);
    }
    const a = args as Record<string, unknown>;

    if (cfg.mode !== "safe") {
      try {
        const out = await unjournaled(runId, stepNo, tool, a);
        return reply.code(out.status).send(out.body);
      } catch (e) {
        return reply502(reply, e);
      }
    }

    const key = idempotencyKey(runId, stepNo, tool, a);
    const c = await pool.connect();
    let released = false;
    try {
      const out = await tracing.withSpan(
        runId,
        `step.${stepNo}`,
        { "step.no": stepNo, tool, "auth.scope": `tool:${tool}` },
        async (_s, stepCtx): Promise<Outcome> => {
          // Protocol step 1: INSERT ... ON CONFLICT DO NOTHING, then read the row, one transaction.
          const planned = await tracing.withSpan(
            runId,
            "journal.plan",
            { "step.no": stepNo, tool, idempotency_key: key.slice(0, 12) },
            async (span): Promise<{ row: Row; fresh: boolean } | Outcome> => {
              await c.query("BEGIN");
              try {
                const run = await c.query("SELECT status, step_no FROM runs WHERE run_id = $1", [runId]);
                if (run.rowCount === 0) {
                  await c.query("ROLLBACK");
                  return { status: 404, body: { error: "no such run" } };
                }
                const ins = await c.query(
                  `INSERT INTO tool_calls (idempotency_key, run_id, step_no, tool, args, state, requires_approval, probe)
                   SELECT $1, $2, $3, $4, $5, 'PLANNED', $6, $7
                   WHERE $3 <= (SELECT step_no FROM runs WHERE run_id = $2)
                   ON CONFLICT DO NOTHING`,
                  [key, runId, stepNo, tool, JSON.stringify(a), requires_approval === true, typeof probe === "string" ? probe : null],
                );
                const r = await c.query<Row>("SELECT * FROM tool_calls WHERE run_id = $1 AND step_no = $2", [runId, stepNo]);
                await c.query("COMMIT");
                const row = r.rows[0];
                if (!row) return { status: 409, body: { error: "step is ahead of the run" } };
                if (row.idempotency_key !== key) {
                  return { status: 409, body: { error: "step already journaled with different input" } };
                }
                span.setAttribute("call.state", row.state);
                return { row, fresh: ins.rowCount === 1 };
              } catch (e) {
                await c.query("ROLLBACK").catch(() => undefined);
                throw e;
              }
            },
            stepCtx,
          );
          if ("status" in planned) return planned;
          const { fresh } = planned;
          if (fresh) touched.add(key);
          // Recovering = the row was journaled by an earlier process (a restart), not a continuation here.
          const recovering = !touched.has(key);
          fire("P1_after_planned", runId, stepNo, recovering, stepCtx);
          const res = await withLock(c, key, true, () => advance(c, key, recovering, stepCtx));
          return res as Outcome;
        },
      );
      c.release();
      released = true;
      return reply.code(out.status).send(out.body);
    } catch (e) {
      if (!released) c.release();
      return reply502(reply, e);
    }
  });

  // ---- startup recovery ----------------------------------------------------------------

  async function recover(): Promise<void> {
    if (cfg.mode !== "safe") return; // unsafe mode: no journal reads on resume
    const { rows } = await pool.query<{ idempotency_key: string; run_id: string; step_no: number }>(
      `SELECT t.idempotency_key, t.run_id, t.step_no FROM tool_calls t JOIN runs r USING (run_id)
       WHERE t.state IN ('PLANNED','SENT','AWAITING_APPROVAL') AND r.status IN ('RUNNING','WAITING_APPROVAL')
       ORDER BY t.run_id, t.step_no`,
    );
    const byRun = new Map<string, typeof rows>();
    for (const r of rows) byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), r]);
    await Promise.all(
      [...byRun].map(([runId, list]) =>
        tracing.withSpan(runId, "recovery.scan", { rows: list.length }, async (_s, scanCtx) => {
          for (const r of list) {
            const c = await pool.connect();
            try {
              await tracing.withSpan(
                runId,
                "recovery.resume",
                { "step.no": r.step_no, idempotency_key: r.idempotency_key.slice(0, 12) },
                async (_s2, ctx) => {
                  // Try-lock: another gateway instance (or a live request) may already own this row.
                  const out = await withLock(c, r.idempotency_key, false, async () => {
                    fire("P1_after_planned", runId, r.step_no, true, ctx);
                    return advance(c, r.idempotency_key, true, ctx);
                  });
                  if (!out) console.error(`recovery skipped ${r.idempotency_key.slice(0, 12)}: locked elsewhere`);
                },
                scanCtx,
              );
            } catch (e) {
              console.error(`recovery error for ${r.idempotency_key.slice(0, 12)}; row left unchanged`, e);
            } finally {
              c.release();
            }
          }
        }),
      ),
    );
  }

  return {
    app,
    pool,
    tracing,
    mcp,
    recover,
    async close() {
      await app.close();
      await mcp.close();
      await pool.end();
    },
  };
}
