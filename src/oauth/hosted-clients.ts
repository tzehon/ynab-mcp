import type { ClientAuthMethod, ClientMetadata } from "oidc-provider";
import type { HostedConfig } from "./hosted-config.js";

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

export function hostedClients(
  config: HostedConfig,
): (ClientMetadata & { token_endpoint_auth_method: ClientAuthMethod })[] {
  const grants = {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  } as const;
  return [
    {
      ...grants,
      client_id: config.nativeId,
      application_type: "native",
      redirect_uris: [config.nativeCallback],
      token_endpoint_auth_method: "none",
    },
    {
      ...grants,
      client_id: config.webId,
      client_secret: config.webSecret,
      application_type: "web",
      redirect_uris: [config.webCallback],
      token_endpoint_auth_method: config.webMethod,
    },
    ...(config.claude
      ? [
          {
            ...grants,
            client_id: config.claude.id,
            client_secret: config.claude.secret,
            application_type: "web" as const,
            redirect_uris: [CLAUDE_CALLBACK],
            token_endpoint_auth_method: "client_secret_post" as const,
          },
        ]
      : []),
  ];
}

// Select the profile from one unambiguous identity. The provider still verifies
// the secret and binds codes/refresh tokens to this client; this is not authentication.
export function approvedTokenMethod(
  config: HostedConfig,
  body: URLSearchParams,
  authorization: string | undefined,
): boolean {
  let id = body.get("client_id");
  if (authorization !== undefined) {
    if (
      body.has("client_secret") ||
      !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(authorization)
    )
      return false;
    const encoded = authorization.slice(6),
      decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) return false;
    const pair = decoded.toString("utf8"),
      colon = pair.indexOf(":");
    if (colon < 1) return false;
    let basicId: string;
    try {
      basicId = decodeURIComponent(pair.slice(0, colon));
    } catch {
      return false;
    }
    if (id !== null && id !== basicId) return false;
    id = basicId;
  }
  const client = hostedClients(config).find((c) => c.client_id === id);
  if (!client) return false;
  switch (client.token_endpoint_auth_method) {
    case "none":
      return authorization === undefined && !body.has("client_secret");
    case "client_secret_post":
      return authorization === undefined && body.has("client_secret");
    case "client_secret_basic":
      return authorization !== undefined && !body.has("client_secret");
    default:
      return false;
  }
}

export function hostedAuthMethods(config: HostedConfig): ClientAuthMethod[] {
  return [
    ...new Set(hostedClients(config).map((c) => c.token_endpoint_auth_method)),
  ];
}
