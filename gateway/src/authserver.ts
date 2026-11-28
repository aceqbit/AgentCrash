import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";

/** In-repo OAuth 2.0 token endpoint (client-credentials grant) with a JWKS endpoint. Replaces Keycloak (DECISIONS D3). */

export interface ClientDef {
  secret_env: string;
  scopes: string[];
}

export interface AuthServerOptions {
  clients: Record<string, ClientDef>;
  env: NodeJS.ProcessEnv;
  issuer: string;
  audience: string;
  /** Token lifetime in seconds; minutes, not hours. */
  ttlSeconds?: number;
  /** Where the signing key is kept between restarts (dev convenience). */
  keyFile?: string;
}

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

async function loadKey(keyFile: string | undefined): Promise<{ priv: JWK; pub: JWK }> {
  if (keyFile && existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, "utf8")) as { priv: JWK; pub: JWK };
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  pub.kid = priv.kid = randomUUID();
  pub.alg = priv.alg = "ES256";
  pub.use = "sig";
  if (keyFile) {
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, JSON.stringify({ priv, pub }));
  }
  return { priv, pub };
}

export async function createAuthServer(opts: AuthServerOptions): Promise<{ app: FastifyInstance; jwks: { keys: JWK[] }; sign: SignFn }> {
  const { priv, pub } = await loadKey(opts.keyFile);
  const key = await importJWK(priv, "ES256");
  const ttl = opts.ttlSeconds ?? 300;
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const sign: SignFn = (claims) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: claims.scope })
      .setProtectedHeader({ alg: "ES256", kid: priv.kid as string })
      .setIssuer(claims.issuer ?? opts.issuer)
      .setAudience(claims.audience ?? opts.audience)
      .setSubject(claims.sub)
      .setIssuedAt(claims.iat ?? now)
      .setExpirationTime(claims.exp ?? now + ttl)
      .setJti(randomUUID())
      .sign(claims.key ?? key);
  };

  const oauthError = (status: number, error: string, description: string) => ({ status, body: { error, error_description: description } });

  app.get("/jwks.json", async () => ({ keys: [pub] }));
  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: Record<string, string> | undefined }>("/token", async (req, reply) => {
    const body = req.body ?? {};
    let id = body.client_id;
    let secret = body.client_secret;
    const basic = req.headers.authorization;
    if (basic?.startsWith("Basic ")) {
      const [i, ...rest] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
      id = i;
      secret = rest.join(":");
    }
    if (body.grant_type !== "client_credentials") {
      const e = oauthError(400, "unsupported_grant_type", "only client_credentials");
      return reply.code(e.status).send(e.body);
    }
    const def = id !== undefined && Object.hasOwn(opts.clients, id) ? opts.clients[id] : undefined;
    const expected = def ? opts.env[def.secret_env] : undefined;
    if (!def || !expected || secret === undefined || !timingSafeEqual(sha(secret), sha(expected))) {
      const e = oauthError(401, "invalid_client", "bad client credentials");
      return reply.code(e.status).send(e.body);
    }
    const asked = body.scope ? body.scope.split(" ").filter(Boolean) : def.scopes;
    const bad = asked.filter((s) => !def.scopes.includes(s));
    if (bad.length > 0) {
      const e = oauthError(400, "invalid_scope", `scope not allowed: ${bad.join(" ")}`);
      return reply.code(e.status).send(e.body);
    }
    const token = await sign({ sub: id as string, scope: asked.join(" ") });
    return { access_token: token, token_type: "Bearer", expires_in: ttl, scope: asked.join(" ") };
  });

  return { app, jwks: { keys: [pub] }, sign };
}

export type SignFn = (claims: {
  sub: string;
  scope: string;
  issuer?: string;
  audience?: string;
  iat?: number;
  exp?: number;
  key?: CryptoKey | Uint8Array;
}) => Promise<string>;
