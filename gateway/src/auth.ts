import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config.js";

export interface Denied {
  status: number;
  body: Record<string, unknown>;
}

export interface Auth {
  /** Verify signature (JWKS), exp, aud, iss and the `tool:<name>` scope. Returns a denial or undefined. */
  authorizeCall(req: FastifyRequest, tool: string): Promise<Denied | undefined>;
  /** approve / reject need the `run:approve` scope. */
  authorizeAdmin(req: FastifyRequest): Promise<Denied | undefined>;
}

export function createAuth(cfg: Config, keys?: JWTVerifyGetKey): Auth {
  if (!cfg.authJwksUrl && !keys) {
    return { authorizeCall: async () => undefined, authorizeAdmin: async () => undefined };
  }
  // JWKS cached with a TTL (jose refetches when the cache is older than cacheMaxAge).
  const jwks = keys ?? createRemoteJWKSet(new URL(cfg.authJwksUrl as string), { cacheMaxAge: 5 * 60_000, cooldownDuration: 5_000 });

  async function check(req: FastifyRequest, scope: string): Promise<Denied | undefined> {
    const h = req.headers.authorization;
    if (!h || !/^Bearer /i.test(h)) return { status: 401, body: { error: "missing bearer token" } };
    try {
      const { payload } = await jwtVerify(h.slice(7).trim(), jwks, {
        audience: cfg.authAudience,
        issuer: cfg.authIssuer,
        algorithms: ["ES256"],
      });
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      if (!scopes.includes(scope)) return { status: 403, body: { error: `missing scope ${scope}` } };
      return undefined;
    } catch (e) {
      const why = e instanceof errors.JWTExpired ? "token expired" : e instanceof errors.JOSEError ? e.code : "invalid token";
      return { status: 401, body: { error: `invalid token: ${why}` } };
    }
  }

  return {
    authorizeCall: (req, tool) => check(req, `tool:${tool}`),
    authorizeAdmin: (req) => check(req, "run:approve"),
  };
}