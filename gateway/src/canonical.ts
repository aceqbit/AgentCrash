import { createHash } from "node:crypto";

/** Sorted keys, no whitespace. JSON.stringify emits UTF-8 text without escaping non-ASCII. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    if (s === undefined) throw new TypeError("value is not JSON serialisable");
    return s;
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  return "{" + parts.join(",") + "}";
}

/** sha256(run_id ":" step_no ":" tool ":" canonical_json(args)), hex, over UTF-8 bytes. */
export function idempotencyKey(runId: string, stepNo: number, tool: string, args: unknown): string {
  const input = `${runId}:${stepNo}:${tool}:${canonicalJson(args)}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}