import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: process.env.INTEGRATION === "1" ? ["test/**/*.int.test.ts"] : ["test/**/*.test.ts"],
    exclude: process.env.INTEGRATION === "1" ? ["node_modules/**"] : ["test/**/*.int.test.ts", "node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});