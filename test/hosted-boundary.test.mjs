import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { Admission } from "../dist/http/admission.js";
import { hostedBoundary } from "../dist/http/hosted-boundary.js";
import { HostedUpstream } from "../dist/oauth/hosted-upstream.js";
const origin = "https://fixture-host.up.railway.app";
function request(
  path = "/auth",
  headers = ["Host", "fixture-host.up.railway.app"],
) {
  const r = new IncomingMessage(new Socket());
  r.url = path;
  r.method = "GET";
  r.rawHeaders = headers;
  r.headers = {};
  for (let i = 0; i < headers.length; i += 2)
    r.headers[headers[i].toLowerCase()] = headers[i + 1];
  return r;
}
test("hosted authority rejects duplicates/hostile targets and discards forwarding authority", () => {
  assert.equal(hostedBoundary(request("/mcp"), origin), "/mcp");
  for (const path of [
    "//evil.example/mcp",
    "http://evil.example/mcp",
    "/mcp#fragment",
    "/mcp\\x",
    "/mcp x",
    "/mcp?" + "a".repeat(8192),
  ])
    assert.throws(() => hostedBoundary(request(path), origin));
  for (const headers of [
    ["Host", "evil.example"],
    [
      "Host",
      "fixture-host.up.railway.app",
      "Host",
      "fixture-host.up.railway.app",
    ],
    ["Host", "fixture-host.up.railway.app", "Origin", origin, "Origin", origin],
    [
      "Host",
      "fixture-host.up.railway.app",
      "Authorization",
      "x",
      "Authorization",
      "y",
    ],
  ])
    assert.throws(() => hostedBoundary(request("/mcp", headers), origin));
  const r = request("/auth", [
    "Host",
    "fixture-host.up.railway.app",
    "Forwarded",
    "host=evil.example;proto=http",
    "X-Forwarded-Host",
    "evil.example",
    "X-Forwarded-Proto",
    "http",
  ]);
  hostedBoundary(r, origin);
  assert.equal(r.headers["x-forwarded-proto"], "https");
  assert.equal(r.headers.forwarded, undefined);
  assert.equal(r.headers["x-forwarded-host"], undefined);
  assert.equal(
    hostedBoundary(
      request("/healthz", ["Host", "healthcheck.railway.app"]),
      origin,
    ),
    "/healthz",
  );
  for (const path of ["/mcp", "/auth", "/healthz?x=1"])
    assert.throws(() =>
      hostedBoundary(
        request(path, ["Host", "healthcheck.railway.app"]),
        origin,
      ),
    );
});
test("global admission has fixed capacity/rate counters and closes without a key map", () => {
  let now = 60000;
  const a = new Admission(() => now);
  const slots = Array.from({ length: 32 }, () => a.enter("/mcp"));
  assert(slots.every(Boolean));
  assert.equal(a.enter("/mcp"), undefined);
  for (const s of slots) {
    s.release();
    s.release();
  }
  for (let i = 0; i < 30; i++) a.enter("/auth").release();
  assert.equal(a.enter("/auth"), undefined);
  for (let i = 0; i < 120; i++) a.enter("/token").release();
  assert.equal(a.enter("/token"), undefined);
  now += 60000;
  assert(a.enter("/auth"));
  assert(a.enter("/token"));
  a.close();
  assert.equal(a.enter("/mcp"), undefined);
});
const response = (value) => Response.json(value);
test("hosted provider permits only split-host token POST and user GET; never budget traffic", async () => {
  const seen = [];
  const transport = async (input, init) => {
    seen.push({
      url: String(input),
      method: init.method,
      redirect: init.redirect,
    });
    return String(input).endsWith("/v1/user")
      ? response({
          data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
        })
      : response({
          access_token: "invented-access",
          refresh_token: "invented-refresh",
          token_type: "bearer",
          expires_in: 3600,
          scope: "read-only",
        });
  };
  const h = new HostedUpstream(
    "fixture-id",
    "fixture-secret",
    `${origin}/connect/ynab/callback`,
    transport,
    () => 0,
  );
  const r = await h.exchange(
    new URLSearchParams({ state: "fixture-state", code: "fixture-code" }),
    "fixture-state",
    "a".repeat(43),
  );
  assert.equal(r.owner, "11111111-1111-4111-8111-111111111111");
  assert.equal(r.tokens.expires, 3600000);
  assert.deepEqual(
    seen.map((v) => [v.url, v.method]),
    [
      ["https://app.ynab.com/oauth/token", "POST"],
      ["https://api.ynab.com/v1/user", "GET"],
    ],
  );
  assert(seen.every((v) => v.redirect === "manual"));
  for (const [url, method] of [
    ["https://api.ynab.com/v1/plans", "GET"],
    ["https://app.ynab.com/v1/user", "GET"],
    ["https://app.ynab.com/oauth/token", "GET"],
    ["https://api.ynab.com/v1/user", "POST"],
    ["https://api.ynab.com/v1/user?x=1", "GET"],
    ["http://api.ynab.com/v1/user", "GET"],
  ])
    await assert.rejects(() => h.request(url, { method }));
  assert.equal(seen.length, 2);
  h.close();
  await assert.rejects(() => h.refresh(r.tokens));
  assert.equal(seen.length, 2);
});
test("hosted provider rejects redirects, malformed/oversized data and unsafe token responses", async () => {
  for (const make of [
    () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    () => new Response("x"),
    () =>
      new Response("a".repeat(65537), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      response({
        access_token: "a",
        token_type: "bearer",
        expires_in: 0,
        refresh_token: "b",
      }),
    () =>
      response({
        access_token: "a",
        token_type: "bearer",
        expires_in: 10,
        scope: "write",
        refresh_token: "b",
      }),
  ]) {
    const h = new HostedUpstream(
      "fixture-id",
      "fixture-secret",
      `${origin}/connect/ynab/callback`,
      async () => make(),
    );
    await assert.rejects(
      () => h.refresh({ access: "a", refresh: "b", expires: 0 }),
      /OAUTH_REJECTED|invalid|unexpected/,
    );
    h.close();
  }
  const h = new HostedUpstream(
    "fixture-id",
    "fixture-secret",
    `${origin}/connect/ynab/callback`,
    async () =>
      response({ access_token: "next", token_type: "bearer", expires_in: 60 }),
    () => 1000,
  );
  assert.deepEqual(
    await h.refresh({ access: "old", refresh: "kept", expires: 0 }),
    { access: "next", refresh: "kept", expires: 61000 },
  );
  h.close();
});
