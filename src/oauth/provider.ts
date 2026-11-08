import type { IncomingMessage, ServerResponse } from "node:http";
import { createLocalJWKSet } from "jose";
import Provider, { errors } from "oidc-provider";
import { adapterFor } from "./adapter.js";
import type { OAuthConfig } from "./config.js";
import { fail } from "./crypto.js";
import { Interactions, readForm, securityHeaders } from "./interactions.js";
import { loadKeys } from "./keys.js";
import { Lifecycle } from "./lifecycle.js";
import { Store } from "./store.js";
import { Upstream } from "./upstream.js";
export function createOAuth(config: OAuthConfig) {
  const keys = loadKeys(config.keyFile, config.dir),
    store = new Store(config.dir, keys);
  const upstream = new Upstream(config),
    lifecycle = new Lifecycle(store, upstream, config.owner);
  const resource = `${config.origin}/mcp`;
  let provider: Provider;
  try {
    provider = new Provider(config.origin, {
      adapter: adapterFor(store),
      clients: [
        {
          client_id: "synthetic-native",
          application_type: "native",
          redirect_uris: [config.nativeCallback],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        {
          client_id: "synthetic-web",
          client_secret: config.webSecret,
          redirect_uris: [config.webCallback],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        },
      ],
      jwks: { keys: keys.signing },
      cookies: {
        keys: [keys.cookie],
        long: { httpOnly: true, sameSite: "lax", secure: false },
        short: { httpOnly: true, sameSite: "lax", secure: false },
      },
      routes: { authorization: "/auth", token: "/token", jwks: "/jwks" },
      ttl: {
        AccessToken: 3600,
        AuthorizationCode: 60,
        Interaction: 300,
        Session: 3600,
        Grant: 3600,
      },
      pkce: { required: () => true },
      scopes: [],
      responseTypes: ["code"],
      features: {
        devInteractions: { enabled: false },
        registration: { enabled: false },
        revocation: { enabled: false },
        introspection: { enabled: false },
        userinfo: { enabled: false },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => {
            throw new errors.InvalidTarget();
          },
          getResourceServerInfo: async (_ctx, r) => {
            if (r !== resource) throw new errors.InvalidTarget();
            return {
              scope: "ynab:read",
              audience: resource,
              accessTokenFormat: "jwt",
              jwt: { sign: { alg: "RS256" } },
              accessTokenTTL: 3600,
            };
          },
        },
      },
      findAccount: async (_ctx, id) => {
        if (id !== config.owner) fail();
        return { accountId: id, claims: async () => ({ sub: id }) };
      },
      loadExistingGrant: async (ctx) => {
        const id = ctx.oidc.result?.consent?.grantId;
        return typeof id === "string" ? provider.Grant.find(id) : undefined;
      },
      extraTokenClaims: async (_ctx, token) => ({
        grant_id: "grantId" in token ? token.grantId : undefined,
      }),
      renderError: async (ctx) => {
        ctx.type = "application/json";
        ctx.body = { error: "OAUTH_REJECTED" };
      },
      clientBasedCORS: () => false,
    });
  } catch (e) {
    store.close();
    throw e;
  }
  provider.on("server_error", () => {});
  provider.use(async (ctx, next) => {
    securityHeaders(ctx.res);
    try {
      if (ctx.path === "/auth") {
        const q = new URLSearchParams(ctx.querystring);
        if (
          ctx.method !== "GET" ||
          q.getAll("resource").length !== 1 ||
          q.get("resource") !== resource ||
          q.get("scope") !== "ynab:read" ||
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256"
        )
          throw new errors.InvalidRequest("OAUTH_REJECTED");
        for (const k of q.keys())
          if (q.getAll(k).length !== 1)
            throw new errors.InvalidRequest("OAUTH_REJECTED");
      }
      if (ctx.path === "/token") {
        const body = await readForm(ctx.req);
        if (
          body.get("resource") !== resource ||
          body.get("grant_type") !== "authorization_code"
        )
          throw new errors.InvalidTarget();
        (ctx.request as typeof ctx.request & { body: unknown }).body =
          Object.fromEntries(body);
      }
      await next();
    } catch {
      ctx.status = 400;
      ctx.body = { error: "invalid_request" };
    }
    if (ctx.status >= 400) {
      ctx.type = "application/json";
      ctx.body = { error: "invalid_request" };
    }
    ctx.remove("Access-Control-Allow-Origin");
  });
  const interactions = new Interactions(
    config,
    provider,
    store,
    upstream,
    lifecycle,
  );
  const pub = keys.signing.map(({ kty, kid, n, e, alg, use }) => ({
    kty,
    kid,
    n,
    e,
    alg,
    use,
  }));
  const resolve = createLocalJWKSet({ keys: pub });
  let active = 0;
  let closing = false;
  return {
    store,
    lifecycle,
    provider,
    verification: {
      keys: { resolve: async () => resolve, close() {} },
      grant: (claims: Record<string, unknown>) => lifecycle.checkGrant(claims),
    },
    async handle(req: IncomingMessage, res: ServerResponse) {
      if (closing || active >= 4) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"temporarily_unavailable"}');
        return;
      }
      active++;
      try {
        const path = new URL(req.url ?? "", config.origin).pathname;
        if (Buffer.byteLength(req.url ?? "") > 8192) fail();
        if (await interactions.handle(req, res, path)) return;
        if (
          ![
            "/auth",
            "/token",
            "/jwks",
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration",
          ].includes(path) &&
          !/^\/auth\/[A-Za-z0-9_-]+$/.test(path)
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        await provider.callback()(req, res);
      } catch {
        if (!res.headersSent) {
          securityHeaders(res);
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "OAUTH_REJECTED" }));
        } else res.destroy();
      } finally {
        active--;
      }
    },
    async close() {
      closing = true;
      upstream.close();
      while (active) await new Promise((r) => setTimeout(r, 10));
      store.close();
    },
  };
}
