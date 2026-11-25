import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { idempotencyKey } from "./canonical.js";
import { createTracing, type Tracing } from "./tracing.js";
import type { Config } from "./config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Gateway {
  app: FastifyInstance;
  pool: pg.Pool;
  tracing: Tracing;
  close(): Promise<void>;
}

export async function buildGateway(cfg: Config): Promise<Gateway> {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 20 });
  const tracing = createTracing({ file: cfg.tracesFile, console: cfg.consoleSpans });
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: { scenario?: string; run_id?: string } }>("/v1/runs", async (req, reply) => {
    const scenario = req.body?.scenario;
    if (typeof scenario !== "string" || scenario.length === 0) {
      return reply.code(400).send({ error: "scenario required" });
    }
    const runId = req.body.run_id ?? randomUUID();
    if (!UUID_RE.test(runId)) return reply.code(400).send({ error: "bad run_id" });
    await pool.query(
      "INSERT INTO runs (run_id, scenario, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT DO NOTHING",
      [runId, scenario],
    );
    tracing.runSpan(runId);
    const { rows } = await pool.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
    return reply.code(201).send(rows[0]);
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

  app.post<{
    Params: { id: string; n: string };
    Body: { tool?: string; args?: unknown };
  }>("/v1/runs/:id/steps/:n/call", async (req, reply) => {
    const runId = req.params.id;
    const stepNo = Number(req.params.n);
    const { tool, args } = req.body ?? {};
    if (!UUID_RE.test(runId) || !Number.isInteger(stepNo) || stepNo < 0) {
      return reply.code(400).send({ error: "bad run id or step" });
    }
    if (typeof tool !== "string" || args === null || typeof args !== "object") {
      return reply.code(400).send({ error: "tool and args required" });
    }
    const key = idempotencyKey(runId, stepNo, tool, args);
    return tracing.withSpan(runId, `step.${stepNo}`, { "step.no": stepNo, tool }, async (_s, stepCtx) => {
      const row = await tracing.withSpan(
        runId,
        "journal.plan",
        { "step.no": stepNo, tool, idempotency_key: key.slice(0, 12) },
        async (span) => {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query(
              `INSERT INTO tool_calls (idempotency_key, run_id, step_no, tool, args, state)
               VALUES ($1, $2, $3, $4, $5, 'PLANNED') ON CONFLICT DO NOTHING`,
              [key, runId, stepNo, tool, JSON.stringify(args)],
            );
            const r = await c.query("SELECT * FROM tool_calls WHERE run_id = $1 AND step_no = $2", [runId, stepNo]);
            await c.query("COMMIT");
            span.setAttribute("call.state", r.rows[0]?.state ?? "none");
            return r.rows[0];
          } catch (e) {
            await c.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            c.release();
          }
        },
        stepCtx,
      );
      if (!row || row.idempotency_key !== key) return reply.code(409).send({ error: "step already journaled with different input" });
      return reply.send({ state: row.state, result: row.result ?? { placeholder: true } });
    });
  });

  return {
    app,
    pool,
    tracing,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}