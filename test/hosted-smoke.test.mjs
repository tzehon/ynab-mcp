import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { randomBytes, createHash } from "node:crypto";
import test from "node:test";
import { hostedApp } from "./helpers/hosted-app.mjs";

for (const profile of ["native", "web", "basic"])
  test(`hosted HTTP pipeline: ${profile} consent, both SDK eras, five tools and disconnect`, async (t) => {
    const { h, e, seen } = await hostedApp(t, {
      method:
        profile === "basic" ? "client_secret_basic" : "client_secret_post",
    });
    const browser = new h.Browser(),
      verifier = randomBytes(32).toString("base64url");
    assert.equal(
      (await browser.fetch("/mcp", { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal((await browser.fetch("/healthz")).status, 200);
    const clientId =
      profile === "native" ? e.OAUTH_NATIVE_CLIENT_ID : e.OAUTH_WEB_CLIENT_ID;
    const redirectUri =
      profile === "native"
        ? e.OAUTH_NATIVE_CALLBACK.replace(":9876", ":9877")
        : e.OAUTH_WEB_CALLBACK;
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "ynab:read offline_access",
      resource: `${h.origin}/mcp`,
      state: "fixture-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    let r = await browser.fetch(`/auth?${q}`);
    assert.equal(r.status, 303, r.text);
    const interaction = r.headers.location;
    r = await browser.fetch(interaction);
    assert.equal(r.status, 200, r.text);
    const csrf = r.text.match(/name="csrf" value="([^"]+)"/)[1];
    assert.match(r.text, /continued access/);
    assert(
      r.headers["content-security-policy"].includes(
        new URL(redirectUri).origin,
      ),
    );
    r = await browser.fetch(interaction, {
      method: "POST",
      headers: {
        origin: h.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, decision: "continue" }).toString(),
    });
    assert.equal(r.status, 303, r.text);
    const provider = new URL(r.headers.location);
    assert.equal(provider.origin, "https://app.ynab.com");
    r = await browser.fetch(
      `/connect/ynab/callback?${new URLSearchParams({ code: "invented-code", state: provider.searchParams.get("state") })}`,
    );
    assert.equal(r.status, 303, r.text);
    let callback;
    for (let i = 0; i < 5 && r.headers.location; i++) {
      if (r.headers.location.startsWith(redirectUri)) {
        callback = new URL(r.headers.location);
        break;
      }
      r = await browser.fetch(r.headers.location);
    }
    assert(callback, r.text);
    assert.equal(callback.searchParams.get("iss"), h.origin);
    const post = async (values) =>
      browser.fetch("/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(profile === "basic"
            ? {
                authorization: `Basic ${Buffer.from(`${clientId}:${e.OAUTH_WEB_SECRET}`).toString("base64")}`,
              }
            : {}),
        },
        body: new URLSearchParams({
          ...values,
          ...(profile === "web" ? { client_secret: e.OAUTH_WEB_SECRET } : {}),
        }).toString(),
      });
    r = await post({
      grant_type: "authorization_code",
      client_id: clientId,
      code: callback.searchParams.get("code"),
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${h.origin}/mcp`,
    });
    assert.equal(r.status, 200, r.text);
    const tokens = r.json();
    assert(tokens.refresh_token);
    r = await post({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    assert.equal(r.status, 200, r.text);
    const renewed = r.json();
    const mcp = (body) =>
      browser.fetch("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${renewed.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify(body),
      });
    r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().result.tools.length, 5);
    for (const era of ["legacy", "modern"]) {
      const sdk = new Client(
        { name: "fixture-hosted-smoke", version: "1.0.0" },
        {
          versionNegotiation: {
            mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
          },
        },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`${h.origin}/mcp`),
        {
          fetch: async (input, init = {}) => {
            const target = new URL(
              input instanceof Request ? input.url : String(input),
            );
            assert.equal(target.href, `${h.origin}/mcp`);
            const headers = new Headers(init.headers);
            headers.set("authorization", `Bearer ${renewed.access_token}`);
            const result = await browser.fetch(target, {
              method: init.method,
              body: init.body,
              headers: Object.fromEntries(headers),
            });
            const hs = new Headers();
            for (const [k, v] of Object.entries(result.headers))
              if (v !== undefined)
                hs.set(k, Array.isArray(v) ? v.join(", ") : v);
            return new Response(
              [204, 304].includes(result.status) ? null : result.text,
              { status: result.status, headers: hs },
            );
          },
        },
      );
      try {
        await sdk.connect(transport);
        assert.equal(sdk.getProtocolEra(), era);
        assert.equal((await sdk.listTools()).tools.length, 5);
        for (const [name, args] of [
          ["ynab_list_plans", {}],
          ["ynab_list_accounts", { plan_id: "fixture-plan-sgd" }],
          ["ynab_list_categories", { plan_id: "fixture-plan-sgd" }],
          [
            "ynab_get_month",
            { plan_id: "fixture-plan-sgd", month: "2026-11-01" },
          ],
          [
            "ynab_list_transactions",
            {
              plan_id: "fixture-plan-sgd",
              since_date: "2026-11-01",
              until_date: "2026-11-07",
            },
          ],
        ]) {
          const result = await sdk.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true);
          assert.equal(result.structuredContent.data_mode, "fixtures");
        }
        const denied = await sdk.callTool({
          name: "ynab_list_accounts",
          arguments: { plan_id: "fixture-plan-usd" },
        });
        assert.equal(denied.isError, true);
      } finally {
        await sdk.close();
      }
    }
    assert.deepEqual(seen, [
      "https://app.ynab.com/oauth/token",
      "https://api.ynab.com/v1/user",
    ]);
    r = await browser.fetch("/connection");
    assert.equal(r.status, 200, r.text);
    const disconnectCsrf = r.text.match(/name="csrf" value="([^"]+)"/)[1];
    r = await browser.fetch("/connection/disconnect", {
      method: "POST",
      headers: {
        origin: h.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: disconnectCsrf }).toString(),
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(
      (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }))
        .status,
      401,
    );
  });
