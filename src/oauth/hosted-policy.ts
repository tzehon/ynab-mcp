import type { Configuration } from "oidc-provider";
import { errors } from "oidc-provider";

export const IDLE_SECONDS = 7 * 86400;
export const ABSOLUTE_SECONDS = 30 * 86400;

// Used only by the hosted engine. Existing local modes keep their own policy.
export function hostedPolicy(resource: string): Partial<Configuration> {
  return {
    scopes: ["offline_access"],
    responseTypes: ["code"],
    pkce: { required: () => true },
    rotateRefreshToken: true,
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 60,
      Interaction: 300,
      Session: 3600,
      Grant: ABSOLUTE_SECONDS,
      RefreshToken: (_ctx, token) =>
        Math.max(
          0,
          Math.min(
            IDLE_SECONDS,
            (token.iiat ?? Math.floor(Date.now() / 1000)) +
              ABSOLUTE_SECONDS -
              Math.floor(Date.now() / 1000),
          ),
        ),
    },
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
        useGrantedResource: () => true,
        getResourceServerInfo: async (_ctx, target) => {
          if (target !== resource) throw new errors.InvalidTarget();
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
  };
}

// Called before provider parsing/filtering, only on the initial authorization
// request. Never add offline_access; force an explicit UI decision if requested.
export function requireConsent(query: URLSearchParams) {
  for (const key of query.keys()) {
    if (query.getAll(key).length !== 1)
      throw new errors.InvalidRequest("OAUTH_REJECTED");
  }
  const prompt = query.get("prompt")?.split(" ") ?? [];
  if (prompt.includes("none")) throw new errors.InteractionRequired();
  if (prompt.some((p) => p !== "consent" && p !== "login"))
    throw new errors.InvalidRequest("OAUTH_REJECTED");
  query.set("prompt", [...new Set([...prompt, "consent"])].join(" "));
  return query;
}
