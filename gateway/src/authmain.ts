import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAuthServer, type ClientDef } from "./authserver.js";

const clientsFile = process.env.AUTH_CLIENTS_FILE ?? resolve(import.meta.dirname, "..", "..", "infra", "auth", "clients.json");
const clients = JSON.parse(readFileSync(clientsFile, "utf8")) as Record<string, ClientDef>;
for (const [id, def] of Object.entries(clients)) {
  if (!process.env[def.secret_env]) throw new Error(`client ${id}: env ${def.secret_env} is not set`);
}
const { app } = await createAuthServer({
  clients,
  env: process.env,
  issuer: process.env.AUTH_ISSUER ?? "agentcrash-auth",
  audience: process.env.AUTH_AUDIENCE ?? "agentcrash-gateway",
  ttlSeconds: Number(process.env.AUTH_TTL_SECONDS ?? 300),
  keyFile: process.env.AUTH_KEY_FILE,
});
const port = Number(process.env.AUTH_PORT ?? 7104);
await app.listen({ port, host: "127.0.0.1" });
console.log(`auth server listening on ${port}`);
