import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DB_URL } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitHttp(url: string, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error(`${url} did not come up`);
}

export function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

export interface Proc {
  child: ChildProcess;
  exited: Promise<number | null>;
}

function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "ignore" });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return { child, exited };
}

export class TestStack {
  dir = mkdtempSync(join(tmpdir(), "stack-"));
  mockPort = randomPort();
  gwPort = randomPort();
  mock?: Proc;
  gw?: Proc;
  marker = join(this.dir, "crash.json");
  traces = join(this.dir, "traces.jsonl");
  gwEnvExtra: Record<string, string> = {};

  get gwUrl(): string {
    return `http://127.0.0.1:${this.gwPort}`;
  }
  get mockUrl(): string {
    return `http://127.0.0.1:${this.mockPort}`;
  }

  async startMock(): Promise<void> {
    this.mock = start("mock-servers/dist/index.js", { MOCK_PORT: String(this.mockPort), MOCK_DIR: join(this.dir, "mock") });
    await waitHttp(`${this.mockUrl}/health`);
  }

  async startGateway(env: Record<string, string> = {}): Promise<Proc> {
    const p = start("gateway/dist/index.js", {
      GATEWAY_PORT: String(this.gwPort),
      DATABASE_URL: DB_URL,
      MCP_URL: `${this.mockUrl}/mcp`,
      TRACES_FILE: this.traces,
      CRASH_MARKER: this.marker,
      ...this.gwEnvExtra,
      ...env,
    });
    this.gw = p;
    await Promise.race([waitHttp(`${this.gwUrl}/health`), p.exited.then(() => undefined)]);
    return p;
  }

  /** Another gateway instance on its own port, sharing the same database and mock server. */
  async startExtraGateway(env: Record<string, string> = {}): Promise<{ proc: Proc; port: number }> {
    const port = randomPort();
    const proc = start("gateway/dist/index.js", {
      GATEWAY_PORT: String(port),
      DATABASE_URL: DB_URL,
      MCP_URL: `${this.mockUrl}/mcp`,
      TRACES_FILE: join(this.dir, `traces-${port}.jsonl`),
      ...env,
    });
    await waitHttp(`http://127.0.0.1:${port}/health`);
    this.extra.push(proc);
    return { proc, port };
  }

  extra: Proc[] = [];

  crashMarker(): { point: string; step: number } | undefined {
    return existsSync(this.marker) ? (JSON.parse(readFileSync(this.marker, "utf8")) as { point: string; step: number }) : undefined;
  }

  async effects(): Promise<Array<{ tool: string; key: string; args: Record<string, unknown> }>> {
    return (await (await fetch(`${this.mockUrl}/_effects`)).json()) as never;
  }

  async stop(): Promise<void> {
    this.gw?.child.kill();
    this.mock?.child.kill();
    for (const e of this.extra) e.child.kill();
    await Promise.all([this.gw?.exited, this.mock?.exited, ...this.extra.map((e) => e.exited)]);
  }
}

export interface StepSpec {
  tool: string;
  args: Record<string, unknown>;
  probe?: string | null;
  requires_approval?: boolean;
}

export const BANK_5: StepSpec[] = [
  { tool: "transfer", args: { from: "A", to: "B", amount: 10 } },
  { tool: "create_ticket", args: { title: "Review transfer" }, requires_approval: true },
  { tool: "send_email", args: { to: "ops@example.test", subject: "Transfer done" }, probe: "list_sent_emails" },
  { tool: "transfer", args: { from: "B", to: "C", amount: 5 } },
  { tool: "send_email", args: { to: "finance@example.test", subject: "All done" }, probe: null },
];

/** A tiny stand-in for the runtime: retries each step until it is DONE, approving AWAITING_APPROVAL. */
export async function drive(
  gwUrl: string,
  runId: string,
  steps: StepSpec[],
  opts: { autoApprove?: boolean; timeoutMs?: number } = {},
): Promise<"DONE" | "UNKNOWN" | "TIMEOUT"> {
  const end = Date.now() + (opts.timeoutMs ?? 30000);
  for (let i = 0; i < steps.length; i++) {
    for (;;) {
      if (Date.now() > end) return "TIMEOUT";
      try {
        const r = await fetch(`${gwUrl}/v1/runs/${runId}/steps/${i}/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(steps[i]),
        });
        if (r.status === 200) break;
        const body = (await r.json()) as { state?: string };
        if (r.status === 202 && body.state === "UNKNOWN") return "UNKNOWN";
        if (r.status === 202 && body.state === "AWAITING_APPROVAL" && opts.autoApprove !== false) {
          await fetch(`${gwUrl}/v1/runs/${runId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        }
      } catch {
        /* gateway down: keep retrying */
      }
      await sleep(100);
    }
  }
  return "DONE";
}