import type { AddressInfo } from "node:net";
import { buildGateway, type Gateway } from "../src/app.js";
import { createAuthServer, type ClientDef } from "../src/authserver.js";
import { testConfig } from "./helpers.js";
import type { FastifyInstance } from "fastify";

export const CLIENTS: Record<string, ClientDef> = {
  "agent-runtime": {
    secret_env: "T_RUNTIME",
    scopes: ["tool:transfer", "tool:create_ticket", "tool:get_balance", "tool:send_email", "tool:list_sent_emails"],
  },
  "agent-readonly": { secret_env: "T_READONLY", scopes: ["tool:get_balance", "tool:list_sent_emails"] },
  operator: { secret_env: "T_OPERATOR", scopes: ["run:approve"] },
};
export const SECRETS: Record<string, string> = { T_RUNTIME: "rs", T_READONLY: "ro", T_OPERATOR: "op" };
export const ISSUER = "agentcrash-auth";
export const AUDIENCE = "agentcrash-gateway";

export interface AuthRig {
  gw: Gateway;
  cfg: ReturnType<typeof testConfig>;
  auth: Awaited<ReturnType<typeof createAuthServer>>;
  authApp: FastifyInstance;
  authUrl: string;
  token(client: string, scope?: string): Promise<string>;
  close(): Promise<void>;
}

/** Real token endpoint + real gateway, both in-process; the gateway talks to a real mock MCP server. */
export async function startRig(mcpUrl: string): Promise<AuthRig> {
  const auth = await createAuthServer({ clients: CLIENTS, env: SECRETS, issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 300 });
  await auth.app.listen({ port: 0, host: "127.0.0.1" });
  const authUrl = `http://127.0.0.1:${(auth.app.server.address() as AddressInfo).port}`;
  const cfg = { ...testConfig(), mcpUrl, authJwksUrl: `${authUrl}/jwks.json`, authAudience: AUDIENCE, authIssuer: ISSUER };
  const gw = await buildGateway(cfg);
  const secretOf = (c: string): string => SECRETS[CLIENTS[c]!.secret_env]!;
  return {
    gw,
    cfg,
    auth,
    authApp: auth.app,
    authUrl,
    async token(client, scope) {
      const body = new URLSearchParams({ grant_type: "client_credentials", client_id: client, client_secret: secretOf(client) });
      if (scope) body.set("scope", scope);
      const r = await fetch(`${authUrl}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      const j = (await r.json()) as { access_token?: string; error?: string };
      if (!j.access_token) throw new Error(`token request failed: ${JSON.stringify(j)}`);
      return j.access_token;
    },
    async close() {
      await gw.close();
      await auth.app.close();
    },
  };
}
