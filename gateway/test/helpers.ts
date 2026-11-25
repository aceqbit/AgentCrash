import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { loadConfig, type Config } from "../src/config.js";

export const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentcrash";

export function testConfig(over: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "agentcrash-"));
  return { ...loadConfig({ DATABASE_URL: DB_URL }), tracesFile: join(dir, "traces.jsonl"), ...over };
}

export async function resetDb(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB_URL });
  await pool.query("TRUNCATE tool_calls, runs CASCADE");
  await pool.end();
}

export function readSpans(file: string | undefined): Array<Record<string, unknown>> {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}