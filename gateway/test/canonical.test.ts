import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { canonicalJson, idempotencyKey } from "../src/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("keeps non-ASCII unescaped", () => {
    expect(canonicalJson({ t: "é€" })).toBe('{"t":"é€"}');
  });
});

describe("idempotencyKey", () => {
  const run = "11111111-1111-4111-8111-111111111111";
  it("ignores key order in args", () => {
    expect(idempotencyKey(run, 0, "transfer", { from: "A", to: "B", amount: 1 })).toBe(
      idempotencyKey(run, 0, "transfer", { amount: 1, to: "B", from: "A" }),
    );
  });
  it("differs for different args, step, tool or run", () => {
    const base = idempotencyKey(run, 0, "transfer", { amount: 1 });
    expect(idempotencyKey(run, 0, "transfer", { amount: 2 })).not.toBe(base);
    expect(idempotencyKey(run, 1, "transfer", { amount: 1 })).not.toBe(base);
    expect(idempotencyKey(run, 0, "create_ticket", { amount: 1 })).not.toBe(base);
    expect(idempotencyKey("22222222-2222-4222-8222-222222222222", 0, "transfer", { amount: 1 })).not.toBe(base);
  });
  it("is a 64 char hex string", () => {
    expect(idempotencyKey(run, 0, "t", {})).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable across process restarts", () => {
    const code = `import {idempotencyKey} from "./src/canonical.ts";process.stdout.write(idempotencyKey("${run}",3,"transfer",{b:1,a:[1,2]}))`;
    const out = (): string =>
      execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], {
        encoding: "utf8",
      });
    expect(out()).toBe(out());
    expect(out()).toBe(idempotencyKey(run, 3, "transfer", { a: [1, 2], b: 1 }));
  });
});