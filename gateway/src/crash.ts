import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CrashPoint = "P1_after_planned" | "P2_after_exec" | "P3_after_commit" | "P4_awaiting_approval";
const POINTS: CrashPoint[] = ["P1_after_planned", "P2_after_exec", "P3_after_commit", "P4_awaiting_approval"];

export interface CrashSpec {
  step: number;
  point: CrashPoint;
}

export function parseCrashAt(v: string | undefined): CrashSpec | undefined {
  if (!v) return undefined;
  const m = /^(\d+):(P[1-4]_[a-z_]+)$/.exec(v);
  const point = POINTS.find((p) => p === m?.[2]);
  if (!m || !point) throw new Error(`bad CRASH_AT: ${v}`);
  return { step: Number(m[1]), point };
}

/** Hooks and unsafe modes exist only outside production, or with ALLOW_CRASH_HOOKS=1. */
export function testHooksAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "production" || env.ALLOW_CRASH_HOOKS === "1";
}

export interface CrashHooks {
  /** `recovering` is true when the call is being resumed rather than processed for the first time. */
  fire(point: CrashPoint, stepNo: number, recovering: boolean, onBeforeKill?: () => void): void;
}

export function createCrashHooks(env: NodeJS.ProcessEnv): CrashHooks {
  const spec = testHooksAllowed(env) ? parseCrashAt(env.CRASH_AT) : undefined;
  if (!testHooksAllowed(env) && env.CRASH_AT) console.error("CRASH_AT ignored: hooks are not allowed in production");
  const onRecovery = env.CRASH_ON_RECOVERY === "1";
  const marker = env.CRASH_MARKER;
  return {
    fire(point, stepNo, recovering, onBeforeKill) {
      if (!spec || spec.step !== stepNo || spec.point !== point) return;
      if (recovering && !onRecovery) return;
      onBeforeKill?.();
      if (marker) {
        // The verifier reads this to confirm the process died by its own hook (Windows reports no signal).
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, JSON.stringify({ pid: process.pid, step: stepNo, point, recovering, ts: Date.now() }));
      }
      process.kill(process.pid, "SIGKILL");
    },
  };
}