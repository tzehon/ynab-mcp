import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { hostedApp } from "./helpers/hosted-app.mjs";
import { mapped, other } from "./helpers/ynab-http.mjs";

for (const live of [false, true])
  for (const profile of [
    "native",
    "web",
    "basic",
    "claude",
    "claude-with-basic-web",
  ])
    test(`hosted HTTP pipeline: ${live ? "live" : "fixtures"} ${profile} consent, both SDK eras, seven tools and disconnect`, async (t) => {
      const { h, e, seen, control } = await hostedApp(t, {
        live,
        claude: profile.startsWith("claude"),
        method: profile.includes("basic")
          ? "client_secret_basic"
          : "client_secret_post",
      });
      const browser = new h.Browser(),
        verifier = randomBytes(32).toString("base64url");
      assert.equal(
        (await browser.fetch("/mcp", { method: "POST", body: "{}" })).status,
        401,
      );
      assert.equal((await browser.fetch("/healthz")).status, 200);
      const clientId =
        profile === "native"
          ? e.OAUTH_NATIVE_CLIENT_ID
          : profile.startsWith("claude")
            ? e.OAUTH_CLAUDE_CLIENT_ID
            : e.OAUTH_WEB_CLIENT_ID;
      const redirectUri =
        profile === "native"
          ? e.OAUTH_NATIVE_CALLBACK.replace(":9876", ":9877")
          : profile.startsWith("claude")
            ? "https://claude.ai/api/mcp/auth_callback"
            : e.OAUTH_WEB_CALLBACK;
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "ynab:read offline_access",
        resource: `${h.origin}/mcp`,
        state: "fixture-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
      let r = await browser.fetch(`/auth?${q}`);
      assert.equal(r.status, 303, r.text);
      const interaction = r.headers.location;
      r = await browser.fetch(interaction);
      assert.equal(r.status, 200, r.text);
      const csrf = r.text.match(/name="csrf" value="([^"]+)"/)[1];
      assert.match(r.text, /continued access/);
      assert.match(r.text, /<title>MCP Tools for YNAB<\/title>/);
      assert.match(r.text, /href="\/privacy"/);
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
            ...(profile === "web"
              ? { client_secret: e.OAUTH_WEB_SECRET }
              : profile.startsWith("claude")
                ? { client_secret: e.OAUTH_CLAUDE_SECRET }
                : {}),
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
      if (live) {
        const anonymous = new h.Browser();
        assert.equal((await anonymous.fetch("/connection/plans")).status, 400);
        r = await browser.fetch("/connection/plans");
        assert.equal(r.status, 200, r.text);
        assert.match(r.text, /Invented &lt;plan&gt; &amp; &quot;name&quot;/);
        const csrf = r.text.match(/name="csrf" value="([^"]+)"/)[1];
        const save = (values, origin = h.origin, navigation = {}) =>
          browser.fetch("/connection/plans", {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/x-www-form-urlencoded",
              ...navigation,
            },
            body: new URLSearchParams(values).toString(),
          });
        assert.equal(
          (await save({ csrf, plan_id: mapped }, "https://evil.example"))
            .status,
          403,
        );
        assert.equal(
          (await save({ csrf: "wrong", plan_id: mapped })).status,
          400,
        );
        assert.equal(
          (
            await save([
              ["csrf", csrf],
              ["plan_id", mapped],
              ["plan_id", mapped],
            ])
          ).status,
          400,
        );
        assert.equal(
          (
            await save({
              csrf,
              plan_id: "33333333-3333-4333-8333-333333333333",
            })
          ).status,
          400,
        );
        assert.equal(
          (await save({ csrf, plan_id: mapped, extra: "denied" })).status,
          400,
        );
        const navigation = {
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        };
        // Real Chromium form POSTs from our no-referrer pages use Origin:null.
        // A complete navigation tuple still cannot replace owner/CSRF checks.
        assert.equal(
          (await save({ csrf, plan_id: mapped }, "null")).status,
          403,
        );
        for (const key of Object.keys(navigation)) {
          const missing = { ...navigation };
          delete missing[key];
          assert.equal(
            (await save({ csrf, plan_id: mapped }, "null", missing)).status,
            403,
          );
        }
        for (const changed of [
          { "sec-fetch-site": "cross-site" },
          { "sec-fetch-site": "none" },
          { "sec-fetch-mode": "cors" },
          { "sec-fetch-dest": "empty" },
        ]) {
          assert.equal(
            (
              await save({ csrf, plan_id: mapped }, "null", {
                ...navigation,
                ...changed,
              })
            ).status,
            403,
          );
        }
        assert.equal(
          (
            await save(
              { csrf, plan_id: mapped },
              "https://evil.example",
              navigation,
            )
          ).status,
          403,
        );
        assert.equal(
          (await save({ csrf: "wrong", plan_id: mapped }, "null", navigation))
            .status,
          400,
        );
        assert.equal(
          (
            await anonymous.fetch("/connection/plans", {
              method: "POST",
              headers: {
                origin: "null",
                "content-type": "application/x-www-form-urlencoded",
                ...navigation,
              },
              body: new URLSearchParams({ csrf, plan_id: mapped }).toString(),
            })
          ).status,
          400,
        );
        r = await save({ csrf, plan_id: mapped }, "null", navigation);
        assert.equal(r.status, 200, r.text);
        assert.equal(
          (await save({ csrf, plan_id: mapped }, "null", navigation)).status,
          400,
        );
      }
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
      if (live) {
        const before = seen.filter(
          (u) => u === "https://app.ynab.com/oauth/token",
        ).length;
        control.tokenDelay = 80;
        const reads = await Promise.all(
          [1, 2].map((id) =>
            mcp({
              jsonrpc: "2.0",
              id: 100 + id,
              method: "tools/call",
              params: {
                name: "ynab_list_accounts",
                arguments: { plan_id: mapped },
              },
            }),
          ),
        );
        for (const result of reads) {
          assert.equal(result.status, 200, result.text);
          assert.notEqual(result.json().result.isError, true, result.text);
        }
        assert.equal(
          seen.filter((u) => u === "https://app.ynab.com/oauth/token").length -
            before,
          1,
        );
        control.tokenDelay = 0;
      }
      r = await mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json().result.tools.length, 7);
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
          assert.equal((await sdk.listTools()).tools.length, 7);
          for (const [name, args] of [
            ["ynab_list_plans", {}],
            [
              "ynab_list_accounts",
              { plan_id: live ? mapped : "fixture-plan-sgd" },
            ],
            [
              "ynab_list_categories",
              { plan_id: live ? mapped : "fixture-plan-sgd" },
            ],
            [
              "ynab_get_month",
              {
                plan_id: live ? mapped : "fixture-plan-sgd",
                month: "2026-11-01",
              },
            ],
            [
              "ynab_get_spending_report",
              {
                plan_id: live ? mapped : "fixture-plan-sgd",
                month: "2026-11-01",
              },
            ],
            [
              "ynab_get_spending_analysis",
              {
                plan_id: live ? mapped : "fixture-plan-sgd",
                first_month: "2026-11-01",
                last_month: "2026-11-01",
                include_open_month: true,
              },
            ],
            [
              "ynab_list_transactions",
              {
                plan_id: live ? mapped : "fixture-plan-sgd",
                since_date: "2026-11-01",
                until_date: "2026-11-07",
              },
            ],
          ]) {
            const result = await sdk.callTool({ name, arguments: args });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            assert.equal(
              result.structuredContent.data_mode,
              live ? "live" : "fixtures",
            );
          }
          const denied = await sdk.callTool({
            name: "ynab_list_accounts",
            arguments: { plan_id: live ? other : "fixture-plan-usd" },
          });
          assert.equal(denied.isError, true);
        } finally {
          await sdk.close();
        }
      }
      if (live)
        assert.equal(
          seen.filter((u) => u.startsWith("https://api.ynab.com/v1/plans"))
            .length,
          31, // Two report and two single-month analysis calls add five GETs each.
        );
      assert.deepEqual(
        [
          ...new Set(
            seen.filter((u) => !u.startsWith("https://api.ynab.com/v1/plans")),
          ),
        ],
        ["https://app.ynab.com/oauth/token", "https://api.ynab.com/v1/user"],
      );
      r = await browser.fetch("/connection");
      assert.match(r.text, /<title>MCP Tools for YNAB<\/title>/);
      assert.match(r.text, /href="\/privacy"/);
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
