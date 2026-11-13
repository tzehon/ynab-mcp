import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createLocalJWKSet } from "jose";
import type { Config } from "../config.js";
import type { LiveService } from "../ynab/live-service.js";
import { fail } from "./crypto.js";
import { Enrollment } from "./enrollment.js";
import { hostedAdmin } from "./hosted-admin.js";
import type { HostedConfig } from "./hosted-config.js";
import { hostedEngine } from "./hosted-engine.js";
import { EnrollmentHttp } from "./hosted-enrollment-http.js";
import { hostedKeys } from "./hosted-keys.js";
import { HostedLifecycle } from "./hosted-lifecycle.js";
import { HostedUpstream } from "./hosted-upstream.js";
import { securityHeaders } from "./interactions.js";
import { claimProcess } from "./process-lock.js";
import { Store } from "./store.js";

export async function hostedService(
  config: HostedConfig,
  fetcher: typeof fetch = fetch,
  application?: Config,
) {
  const keys = hostedKeys(config.keyBundle),
    claim = claimProcess(join(config.dir, "owner.lock"));
  let live: LiveService | undefined;
  let store: Store | undefined,
    admin: Awaited<ReturnType<typeof hostedAdmin>> | undefined;
  const upstream = new HostedUpstream(
    config.ynabId,
    config.ynabSecret,
    `${config.origin}/connect/ynab/callback`,
    fetcher,
  );
  try {
    store = new Store(config.dir, keys, undefined, true);
    const marker = store.get("HostedSchema", "mode");
    if (marker?.version !== 1) {
      if (store.count() !== 1) fail();
      store.put(
        "HostedSchema",
        "mode",
        { version: 1 },
        Number.MAX_SAFE_INTEGER,
      );
    }
    const enrollment = new Enrollment(store, config.enrollment);
    const lifecycle =
      config.enrollment.kind === "owner"
        ? new HostedLifecycle(store, upstream, config.enrollment.owner)
        : undefined;
    if (config.dataMode === "live") {
      if (!lifecycle || !application) fail();
      const { LiveService } = await import("../ynab/live-service.js");
      live = new LiveService(application, store, lifecycle, fetcher);
    }
    const engine = lifecycle
      ? hostedEngine(config, keys, store, upstream, lifecycle, live)
      : undefined;
    const bootstrap = new EnrollmentHttp(config, store, enrollment, upstream);
    admin = await hostedAdmin(config.runtimeDir, enrollment);
    const publicKeys = keys.signing.map(({ kty, kid, n, e, alg, use }) => ({
      kty,
      kid,
      n,
      e,
      alg,
      use,
    }));
    const currentKeys = () =>
      keys.retiringUntil && Date.now() >= keys.retiringUntil
        ? publicKeys.slice(0, 1)
        : publicKeys;
    let active = 0,
      closing = false;
    return {
      enrollment: config.enrollment.kind === "enroll",
      live,
      ready() {
        if (
          closing ||
          store?.get("HostedSchema", "mode")?.version !== 1 ||
          store.get("KeyCheck", "key")?.valid !== true ||
          !enrollment.status()
        )
          fail();
        lifecycle?.ready();
        engine?.families.ready();
      },
      verification: {
        keys: {
          resolve: async () => createLocalJWKSet({ keys: currentKeys() }),
          close() {},
        },
        grant: (claims: Record<string, unknown>) => {
          if (
            !engine ||
            !lifecycle ||
            typeof claims.grant_id !== "string" ||
            typeof claims.client_id !== "string" ||
            typeof claims.sub !== "string"
          )
            fail();
          if (live) lifecycle.checkAuthorization();
          else lifecycle.check();
          engine.families.check(
            claims.grant_id,
            claims.client_id,
            claims.sub,
            `${config.origin}/mcp`,
          );
        },
      },
      async handle(req: IncomingMessage, res: ServerResponse) {
        if (closing) {
          res.writeHead(503);
          res.end();
          return;
        }
        active++;
        try {
          securityHeaders(res);
          const path = new URL(req.url ?? "", config.origin).pathname;
          if (
            !engine &&
            [
              "/.well-known/oauth-authorization-server",
              "/.well-known/openid-configuration",
            ].includes(path)
          ) {
            if (!["GET", "HEAD"].includes(req.method ?? "")) fail();
            res.setHeader("Content-Type", "application/json");
            res.end(
              req.method === "HEAD"
                ? undefined
                : JSON.stringify({
                    issuer: config.origin,
                    authorization_endpoint: `${config.origin}/auth`,
                    token_endpoint: `${config.origin}/token`,
                    jwks_uri: `${config.origin}/jwks`,
                    response_types_supported: ["code"],
                    grant_types_supported: [
                      "authorization_code",
                      "refresh_token",
                    ],
                    scopes_supported: ["ynab:read", "offline_access"],
                    code_challenge_methods_supported: ["S256"],
                    authorization_response_iss_parameter_supported: true,
                    token_endpoint_auth_methods_supported: [
                      "none",
                      config.webMethod,
                    ],
                  }),
            );
            return;
          }
          if (path === "/jwks") {
            if (!["GET", "HEAD"].includes(req.method ?? "")) fail();
            res.setHeader("Content-Type", "application/json");
            res.end(
              req.method === "HEAD"
                ? undefined
                : JSON.stringify({ keys: currentKeys() }),
            );
            return;
          }
          if (!engine) {
            await bootstrap.handle(req, res, path);
            return;
          }
          await engine.handle(req, res, path);
        } catch {
          if (!res.headersSent) {
            securityHeaders(res);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"OAUTH_REJECTED"}');
          } else res.destroy();
        } finally {
          active--;
        }
      },
      async close() {
        closing = true;
        live?.close();
        upstream.close();
        while (active) await new Promise((r) => setTimeout(r, 10));
        await admin?.close();
        store?.close();
        claim.release();
      },
    };
  } catch (error) {
    live?.close();
    upstream.close();
    await admin?.close();
    store?.close();
    claim.release();
    throw error;
  }
}
