import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { createCrashHooks } from "../src/crash.js";

describe("test-only modes are impossible in production", () => {
  it("rejects GATEWAY_MODE=unsafe and passthrough when NODE_ENV=production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", GATEWAY_MODE: "unsafe" })).toThrow(/production/);
    expect(() => loadConfig({ NODE_ENV: "production", GATEWAY_MODE: "passthrough" })).toThrow(/production/);
  });
  it("allows them with ALLOW_CRASH_HOOKS=1 or outside production", () => {
    expect(loadConfig({ NODE_ENV: "production", ALLOW_CRASH_HOOKS: "1", GATEWAY_MODE: "unsafe" }).mode).toBe("unsafe");
    expect(loadConfig({ GATEWAY_MODE: "unsafe" }).mode).toBe("unsafe");
  });
  it("ignores CRASH_AT in production", () => {
    const hooks = createCrashHooks({ NODE_ENV: "production", CRASH_AT: "0:P1_after_planned" });
    expect(() => hooks.fire("P1_after_planned", 0, false)).not.toThrow(); // would SIGKILL this process if armed
  });
});
