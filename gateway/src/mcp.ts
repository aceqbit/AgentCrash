import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const KEY_META = "agentcrash/idempotency_key";

export class ToolError extends Error {}

export interface McpCaller {
  call(tool: string, args: Record<string, unknown>, key?: string): Promise<unknown>;
  close(): Promise<void>;
}

/** One lazily connected client, dropped on any transport error so the next call reconnects. */
export function createMcpCaller(url: string): McpCaller {
  let client: Promise<Client> | undefined;
  const connect = (): Promise<Client> => {
    const c = new Client({ name: "agentcrash-gateway", version: "0.1.0" });
    return c.connect(new StreamableHTTPClientTransport(new URL(url))).then(() => c);
  };
  return {
    async call(tool, args, key) {
      client ??= connect();
      let c: Client;
      try {
        c = await client;
      } catch (e) {
        client = undefined;
        throw e;
      }
      let res;
      try {
        res = await c.callTool({ name: tool, arguments: args, ...(key ? { _meta: { [KEY_META]: key } } : {}) });
      } catch (e) {
        client = undefined;
        void c.close().catch(() => undefined);
        throw e;
      }
      const content = res.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.find((p) => p.type === "text")?.text;
      if (res.isError) throw new ToolError(text ?? "tool error");
      return text === undefined ? null : (JSON.parse(text) as unknown);
    },
    async close() {
      const c = client;
      client = undefined;
      if (c) await (await c).close().catch(() => undefined);
    },
  };
}