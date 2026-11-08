import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { AuthError } from "./errors.js";
export function authResponse(error: unknown, audience: string): Response {
  const kind = error instanceof AuthError ? error.kind : "invalid";
  const metadata = getOAuthProtectedResourceMetadataUrl(new URL(audience));
  let response: Response;
  if (kind === "missing") {
    response = Response.json(
      { error: "AUTH_REQUIRED" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="ynab:read"`,
        },
      },
    );
  } else if (kind === "owner" || kind === "unavailable") {
    response = Response.json(
      { error: kind === "owner" ? "access_denied" : "AUTH_UNAVAILABLE" },
      { status: kind === "owner" ? 403 : 503 },
    );
  } else {
    response = bearerAuthChallengeResponse(
      new OAuthError(
        kind === "scope"
          ? OAuthErrorCode.InsufficientScope
          : OAuthErrorCode.InvalidToken,
        "AUTH_REJECTED",
      ),
      { requiredScopes: ["ynab:read"], resourceMetadataUrl: metadata },
    );
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
