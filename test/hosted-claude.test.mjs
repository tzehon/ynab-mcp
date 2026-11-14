import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { hostedApp } from "./helpers/hosted-app.mjs";
import { approvedTokenMethod } from "../dist/oauth/hosted-clients.js";

const callback = "https://claude.ai/api/mcp/auth_callback";
const csrf = (r) => r.text.match(/name="csrf" value="([^"]+)"/)[1];
const basic = (id, secret) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

for (const method of ["client_secret_post", "client_secret_basic"])
  test(`Claude isolates credentials, callbacks, codes and refresh tokens from ${method} web client`, async (t) => {
    const { h, e, restart } = await hostedApp(t, { claude: true, method });
    const b = new h.Browser();
    const token = (values, headers = {}) =>
      b.fetch("/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(values).toString(),
      });
    const client = (name) =>
      name === "claude"
        ? {
            id: e.OAUTH_CLAUDE_CLIENT_ID,
            secret: e.OAUTH_CLAUDE_SECRET,
            redirect: callback,
          }
        : {
            id: e.OAUTH_WEB_CLIENT_ID,
            secret: e.OAUTH_WEB_SECRET,
            redirect: e.OAUTH_WEB_CALLBACK,
          };
    const credentials = (name) => {
      const c = client(name);
      return name === "web" && method === "client_secret_basic"
        ? {
            values: { client_id: c.id },
            headers: { authorization: basic(c.id, c.secret) },
          }
        : { values: { client_id: c.id, client_secret: c.secret }, headers: {} };
    };
    const redeem = (name, values) => {
      const c = credentials(name);
      return token({ ...values, ...c.values }, c.headers);
    };
    const authorize = async (name) => {
      const c = client(name),
        verifier = randomBytes(32).toString("base64url");
      const params = {
        client_id: c.id,
        redirect_uri: c.redirect,
        response_type: "code",
        scope: "ynab:read offline_access",
        resource: `${h.origin}/mcp`,
        state: "invented-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      };
      let response = await b.fetch(`/auth?${new URLSearchParams(params)}`);
      assert.equal(response.status, 303);
      const path = response.headers.location;
      response = await b.fetch(path);
      assert.equal(response.status, 200);
      response = await b.fetch(path, {
        method: "POST",
        headers: {
          origin: h.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrf: csrf(response),
          decision: "continue",
        }).toString(),
      });
      assert.equal(response.status, 303);
      const upstream = new URL(response.headers.location);
      response = await b.fetch(
        `/connect/ynab/callback?${new URLSearchParams({ code: "invented-code", state: upstream.searchParams.get("state") })}`,
      );
      for (
        let i = 0;
        i < 5 && response.headers.location?.startsWith(h.origin);
        i++
      )
        response = await b.fetch(response.headers.location);
      const result = new URL(response.headers.location);
      assert.equal(result.origin + result.pathname, c.redirect);
      assert(result.searchParams.get("code"));
      return {
        grant_type: "authorization_code",
        code: result.searchParams.get("code"),
        redirect_uri: c.redirect,
        code_verifier: verifier,
        resource: `${h.origin}/mcp`,
      };
    };
    const metadata = (
      await b.fetch("/.well-known/oauth-authorization-server")
    ).json();
    assert.deepEqual(
      new Set(metadata.token_endpoint_auth_methods_supported),
      new Set(["none", method, "client_secret_post"]),
    );
    assert.equal(metadata.registration_endpoint, undefined);
    assert.deepEqual(metadata.scopes_supported, ["ynab:read", "offline_access"]);
    const badAuth = await b.fetch(
      `/auth?${new URLSearchParams({ client_id: e.OAUTH_CLAUDE_CLIENT_ID, redirect_uri: "https://attacker.example/callback", response_type: "code", scope: "ynab:read", resource: `${h.origin}/mcp`, code_challenge_method: "S256", code_challenge: "a".repeat(43) })}`,
    );
    assert(badAuth.status >= 400);
    for (const kind of ["missing", "wrong", "basic", "mixed", "different-id"]) {
      const code = await authorize("claude");
      const values = { ...code, client_id: e.OAUTH_CLAUDE_CLIENT_ID };
      const headers = {};
      if (kind === "wrong") values.client_secret = e.OAUTH_WEB_SECRET;
      if (kind === "basic")
        headers.authorization = basic(
          e.OAUTH_CLAUDE_CLIENT_ID,
          e.OAUTH_CLAUDE_SECRET,
        );
      if (kind === "mixed" || kind === "different-id") {
        values.client_secret = e.OAUTH_CLAUDE_SECRET;
        headers.authorization = basic(
          kind === "mixed" ? e.OAUTH_CLAUDE_CLIENT_ID : e.OAUTH_WEB_CLIENT_ID,
          e.OAUTH_WEB_SECRET,
        );
      }
      const denied = await token(values, headers);
      // Invalid credentials use OAuth 401; profile/input rejection uses 400.
      assert.equal(denied.status, kind === "wrong" ? 401 : 400, kind);
      assert(!denied.json().access_token);
    }
    for (const [source, other] of [
      ["claude", "web"],
      ["web", "claude"],
    ]) {
      const code = await authorize(source);
      assert.equal((await redeem(other, code)).status, 400);
      const issued = await redeem(source, await authorize(source));
      assert.equal(issued.status, 200, issued.text);
      const refresh = {
        grant_type: "refresh_token",
        refresh_token: issued.json().refresh_token,
      };
      assert.equal((await redeem(other, refresh)).status, 400);
      await restart();
      const renewed = await redeem(source, refresh);
      assert.equal(renewed.status, 200, renewed.text);
      assert(renewed.json().access_token);
      // A consumed token cannot be replayed even after successful rotation.
      assert.equal((await redeem(source, refresh)).status, 400);
      assert.equal(
        (
          await redeem(source, {
            ...refresh,
            refresh_token: renewed.json().refresh_token,
          })
        ).status,
        400,
      );
    }
  });

test("authentication profile selection rejects ambiguous and malformed Basic credentials", () => {
  const c = {
    nativeId: "fixture-native",
    webId: "fixture-web",
    webMethod: "client_secret_basic",
    claude: { id: "fixture-claude", secret: "invented" },
  };
  const body = (values) => new URLSearchParams(values);
  assert(approvedTokenMethod(c, body({}), basic(c.webId, "invented")));
  assert(approvedTokenMethod(c, body({ client_id: c.nativeId }), undefined));
  assert(
    approvedTokenMethod(
      c,
      body({ client_id: c.claude.id, client_secret: "invented" }),
      undefined,
    ),
  );
  for (const [values, header] of [
    [{}, "Bearer invented"],
    [{}, "Basic !!!"],
    [{}, basic("%ZZ", "invented")],
    [{ client_id: c.claude.id }, basic(c.webId, "invented")],
    [
      { client_id: c.webId, client_secret: "invented" },
      basic(c.webId, "invented"),
    ],
    [{ client_id: c.nativeId, client_secret: "invented" }, undefined],
    [{ client_id: "unknown-client" }, undefined],
  ])
    assert.equal(approvedTokenMethod(c, body(values), header), false);
});
