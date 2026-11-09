import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors } from "oidc-provider";
import { hostedAdapter } from "./hosted-adapter.js";
import type { HostedConfig } from "./hosted-config.js";
import { HostedInteractions } from "./hosted-interactions.js";
import type { HostedKeys } from "./hosted-keys.js";
import type { HostedLifecycle } from "./hosted-lifecycle.js";
import { hostedPolicy, requireConsent } from "./hosted-policy.js";
import type { HostedUpstream } from "./hosted-upstream.js";
import { readForm, securityHeaders } from "./interactions.js";
import { RefreshFamilies, type Reservation } from "./refresh-families.js";
import type { Store } from "./store.js";
import { fail } from "./crypto.js";

export function hostedEngine(
  config: HostedConfig,
  keys: HostedKeys,
  store: Store,
  upstream: HostedUpstream,
  lifecycle: HostedLifecycle,
) {
  if (config.enrollment.kind !== "owner") fail();
  const owner = config.enrollment.owner,
    resource = `${config.origin}/mcp`,
    families = new RefreshFamilies(store, () => lifecycle.generation()),
    context = new AsyncLocalStorage<{
      family?: string;
      reservation?: Reservation;
    }>();
  const provider = new Provider(config.origin, {
    ...hostedPolicy(resource),
    adapter: hostedAdapter(store, families, () => lifecycle.check()),
    clients: [
      {
        client_id: config.nativeId,
        application_type: "native",
        redirect_uris: [config.nativeCallback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      {
        client_id: config.webId,
        client_secret: config.webSecret,
        application_type: "web",
        redirect_uris: [config.webCallback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: config.webMethod,
      },
    ],
    jwks: { keys: keys.signing },
    cookies: {
      keys: [keys.cookie],
      long: { httpOnly: true, secure: true, sameSite: "lax" },
      short: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    routes: { authorization: "/auth", token: "/token", jwks: "/jwks" },
    findAccount: async (ctx, id) => {
      if (id !== owner) fail();
      const source =
        ctx.oidc.entities.RefreshToken ?? ctx.oidc.entities.AuthorizationCode;
      if (ctx.path === "/token" && source) {
        const op = context.getStore();
        if (
          !op ||
          !source.grantId ||
          !source.clientId ||
          source.clientId !== ctx.oidc.client?.clientId
        )
          fail();
        op.family = source.grantId;
        op.reservation = families.reserve(
          source.grantId,
          source.clientId,
          id,
          !ctx.oidc.entities.RefreshToken,
          !!ctx.oidc.entities.RefreshToken?.consumed,
        );
        await lifecycle.refresh();
        lifecycle.check();
      }
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
  provider.proxy = true; // Request can reach this only through hostedBoundary.
  provider.on("server_error", () => {});
  provider.use(async (ctx, next) =>
    context.run({}, async () => {
      securityHeaders(ctx.res);
      const op = context.getStore();
      try {
        if (ctx.path === "/auth") {
          const q = new URLSearchParams(ctx.querystring);
          const scopes = q.get("scope")?.split(" ") ?? [];
          if (
            ctx.method !== "GET" ||
            q.get("resource") !== resource ||
            q.get("response_type") !== "code" ||
            q.get("code_challenge_method") !== "S256" ||
            !scopes.includes("ynab:read") ||
            scopes.some((s) => s !== "ynab:read" && s !== "offline_access") ||
            new Set(scopes).size !== scopes.length
          )
            throw new errors.InvalidRequest("OAUTH_REJECTED");
          ctx.querystring = requireConsent(q).toString();
        }
        if (ctx.path === "/token") {
          const body = await readForm(ctx.req),
            grant = body.get("grant_type");
          if (
            !["authorization_code", "refresh_token"].includes(grant ?? "") ||
            (grant === "authorization_code" &&
              body.get("resource") !== resource) ||
            (body.has("resource") && body.get("resource") !== resource)
          )
            throw new errors.InvalidTarget();
          // Engine accepts Basic/Post interchangeably; enforce the approved exact
          // static profile before letting the engine authenticate credentials.
          if (
            (config.webMethod === "client_secret_post" &&
              ctx.headers.authorization !== undefined) ||
            (config.webMethod === "client_secret_basic" &&
              body.has("client_secret"))
          )
            throw new errors.InvalidClientAuth();
          (ctx.request as typeof ctx.request & { body: unknown }).body =
            Object.fromEntries(body);
        }
        await next();
        const result = ctx.body as Record<string, unknown> | undefined;
        if (
          ctx.path === "/token" &&
          result?.error === "invalid_grant" &&
          ctx.oidc.params?.grant_type === "refresh_token"
        ) {
          const previous = await provider.RefreshToken.find(
            String(ctx.oidc.params.refresh_token),
            { ignoreExpiration: true },
          );
          if (
            previous?.consumed &&
            previous.clientId === ctx.oidc.client?.clientId &&
            previous.grantId
          )
            families.revoke(previous.grantId);
        }
        if (op?.family) {
          if (ctx.status !== 200 || !result?.access_token || !op.reservation)
            fail();
          lifecycle.check();
          families.finish(op.reservation, true);
          const reservation = op.reservation;
          const abort = () => {
            if (!ctx.res.writableFinished)
              try {
                families.revoke(reservation.family);
              } catch {}
          };
          ctx.res.once("close", abort);
          ctx.res.once("finish", () => {
            ctx.res.off("close", abort);
            try {
              families.delivered(reservation);
            } catch {
              /* failed store denies all admission */
            }
          });
        }
      } catch {
        if (op?.family) {
          try {
            families.revoke(op.family);
          } catch {
            /* store failure already denies access */
          }
        }
        ctx.status = 400;
        ctx.body = { error: "invalid_grant" };
      }
      if (ctx.status >= 400) {
        ctx.type = "application/json";
        ctx.body = { error: "invalid_request" };
      }
      ctx.remove("Access-Control-Allow-Origin");
    }),
  );
  const interactions = new HostedInteractions(
    config,
    provider,
    store,
    upstream,
    lifecycle,
    families,
  );
  return {
    provider,
    families,
    async handle(req: IncomingMessage, res: ServerResponse, path: string) {
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
    },
  };
}
