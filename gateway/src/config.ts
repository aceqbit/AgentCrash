export interface Config {
  port: number;
  databaseUrl: string;
  mcpUrl: string;
  tracesFile: string | undefined;
  consoleSpans: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.GATEWAY_PORT ?? 7102),
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentcrash",
    mcpUrl: env.MCP_URL ?? "http://127.0.0.1:7101/mcp",
    tracesFile: env.TRACES_FILE ?? "results/traces.jsonl",
    consoleSpans: env.CONSOLE_SPANS === "1",
  };
}