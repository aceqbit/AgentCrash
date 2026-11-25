import { testHooksAllowed } from "./crash.js";

export type GatewayMode = "safe" | "unsafe" | "passthrough";

export interface Config {
  port: number;
  databaseUrl: string;
  mcpUrl: string;
  tracesFile: string | undefined;
  consoleSpans: boolean;
  mode: GatewayMode;
  env: NodeJS.ProcessEnv;
  /** Run startup recovery after listen. */
  recoverOnStart: boolean;
  authJwksUrl: string | undefined;
  authAudience: string;
  authIssuer: string;
  maxArgsBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.GATEWAY_MODE ?? "safe") as GatewayMode;
  if (!["safe", "unsafe", "passthrough"].includes(mode)) throw new Error(`bad GATEWAY_MODE: ${mode}`);
  if (mode !== "safe" && !testHooksAllowed(env)) {
    throw new Error(`GATEWAY_MODE=${mode} is not available in production builds`);
  }
  return {
    port: Number(env.GATEWAY_PORT ?? 7102),
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentcrash",
    mcpUrl: env.MCP_URL ?? "http://127.0.0.1:7101/mcp",
    tracesFile: env.TRACES_FILE ?? "results/traces.jsonl",
    consoleSpans: env.CONSOLE_SPANS === "1",
    mode,
    env,
    recoverOnStart: env.RECOVER_ON_START !== "0",
    authJwksUrl: env.AUTH_JWKS_URL,
    authAudience: env.AUTH_AUDIENCE ?? "agentcrash-gateway",
    authIssuer: env.AUTH_ISSUER ?? "agentcrash-auth",
    maxArgsBytes: Number(env.MAX_ARGS_BYTES ?? 16384),
  };
}
