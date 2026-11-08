import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt } from "jose";
import { authorize, exchange, harness } from "./helpers/integrated-auth.mjs";

test("integrated native consent and YNAB flow issues a separate MCP token", async (t) => {
  const h = await harness(t),
    a = await authorize(h);
  assert(a.params.has("code"));
  const token = await exchange(h, a);
  assert.equal(token.status, 200, JSON.stringify(token.body));
  const jwt = decodeJwt(token.body.access_token);
  assert.equal(jwt.sub, h.env.AUTH_ALLOWED_SUBJECT);
  assert.equal(jwt.aud, `${h.origin}/mcp`);
  assert(jwt.grant_id);
  assert.equal(h.mock.counts.user, 1);
  assert.equal((await exchange(h, a)).status, 400);
});

import { createHash, randomBytes } from "node:crypto";
import { runSmoke } from "../scripts/smoke-mcp.mjs";
import { Browser } from "./helpers/integrated-auth.mjs";

async function connectionPost(h, browser, path) {
  const r = await browser.fetch(`${h.origin}/connection`),
    text = await r.text(),
    csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert(csrf);
  return browser.fetch(`${h.origin}/connection/${path}`, {
    method: "POST",
    headers: {
      origin: h.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf }),
  });
}
test("both client profiles run both SDK eras; disconnect revokes JWT across restart", async (t) => {
  const h = await harness(t);
  for (const client of ["synthetic-native", "synthetic-web"]) {
    const a = await authorize(h, { client }),
      token = await exchange(
        h,
        a,
        client === "synthetic-web"
          ? { client_id: client, client_secret: h.env.OAUTH_WEB_SECRET }
          : {},
      );
    assert.equal(token.status, 200, JSON.stringify(token.body));
    const before = { ...h.mock.counts };
    await runSmoke(`${h.origin}/mcp`, () => {}, token.body.access_token);
    assert.deepEqual(h.mock.counts, before);
    await h.stop();
    await h.start();
    await runSmoke(`${h.origin}/mcp`, () => {}, token.body.access_token);
    const disconnected = await connectionPost(h, a.browser, "disconnect");
    assert.equal(disconnected.status, 200);
    await assert.rejects(
      runSmoke(`${h.origin}/mcp`, () => {}, token.body.access_token),
    );
    await h.stop();
    await h.start();
    await assert.rejects(
      runSmoke(`${h.origin}/mcp`, () => {}, token.body.access_token),
    );
  }
});
test("denied consent and wrong upstream owner cannot issue credentials", async (t) => {
  const h = await harness(t);
  const a = await authorize(h, { decision: "deny" });
  assert.equal(a.params.get("error"), "access_denied");
  assert.equal(h.mock.counts.exchange, 0);
  h.mock.controls.wrongOwner = true;
  await assert.rejects(authorize(h), /FLOW_400/);
});
test("authorization rejects missing or substituted resource, scopes, PKCE, callback and unknown client", async (t) => {
  const h = await harness(t);
  const good = {
    client_id: "synthetic-native",
    redirect_uri: h.env.OAUTH_NATIVE_CALLBACK,
    response_type: "code",
    scope: "ynab:read",
    resource: `${h.origin}/mcp`,
    state: "s",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(randomBytes(32))
      .digest("base64url"),
  };
  for (const patch of [
    { resource: "" },
    { resource: "https://wrong.example/mcp" },
    { scope: "write" },
    { code_challenge_method: "plain" },
    { redirect_uri: "https://wrong.example/callback" },
    { client_id: "unknown" },
  ]) {
    const r = await fetch(
      `${h.origin}/auth?${new URLSearchParams({ ...good, ...patch })}`,
      { redirect: "manual" },
    );
    assert(
      r.status >= 400 ||
        new URL(r.headers.get("location"), h.origin).searchParams.has("error"),
    );
  }
  assert.equal(h.mock.counts.exchange, 0);
});
test("bad verifier, client secret and token resource fail; concurrent code exchange succeeds once", async (t) => {
  const h = await harness(t);
  let a = await authorize(h);
  assert.equal((await exchange(h, a, { code_verifier: "wrong" })).status, 400);
  a = await authorize(h);
  assert.equal(
    (await exchange(h, a, { resource: "https://wrong.example/mcp" })).status,
    400,
  );
  a = await authorize(h, { client: "synthetic-web" });
  assert.equal(
    (
      await exchange(h, a, {
        client_id: "synthetic-web",
        client_secret: "wrong",
      })
    ).status,
    401,
  );
  a = await authorize(h);
  const r = await Promise.all([exchange(h, a), exchange(h, a)]);
  assert.equal(r.filter((x) => x.status === 200).length, 1);
});
test("connection mutations require owner, Origin, CSRF and POST", async (t) => {
  const h = await harness(t),
    a = await authorize(h);
  for (const path of ["refresh", "disconnect"]) {
    const url = `${h.origin}/connection/${path}`;
    assert.equal((await a.browser.fetch(url)).status, 400);
    assert.equal(
      (
        await a.browser.fetch(url, {
          method: "POST",
          body: new URLSearchParams({ csrf: "wrong" }),
          headers: { origin: h.origin },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.browser.fetch(url, {
          method: "POST",
          body: new URLSearchParams({ csrf: "wrong" }),
          headers: { origin: "https://wrong.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await new Browser().fetch(url, {
          method: "POST",
          body: new URLSearchParams({ csrf: "wrong" }),
          headers: { origin: h.origin },
        })
      ).status,
      400,
    );
  }
  assert.equal((await a.browser.fetch(`${h.origin}/connection`)).status, 200);
});
test("upstream refresh preserves omitted replacement and failure disconnects", async (t) => {
  const h = await harness(t);
  h.mock.controls.expires = 1;
  const a = await authorize(h);
  h.mock.controls.omitReplacement = true;
  await new Promise((r) => setTimeout(r, 1050));
  assert.equal((await connectionPost(h, a.browser, "refresh")).status, 200);
  assert.equal(h.mock.counts.refresh, 1);
  await new Promise((r) => setTimeout(r, 1050));
  h.mock.controls.refreshFailure = true;
  assert.equal((await connectionPost(h, a.browser, "refresh")).status, 400);
  assert.equal((await a.browser.fetch(`${h.origin}/connection`)).status, 400);
});
test("separate client grants remain usable until owner disconnect", async (t) => {
  const h = await harness(t),
    a = await authorize(h),
    first = await exchange(h, a),
    b = await authorize(h, { client: "synthetic-web" }),
    second = await exchange(h, b, {
      client_id: "synthetic-web",
      client_secret: h.env.OAUTH_WEB_SECRET,
    });
  await runSmoke(`${h.origin}/mcp`, () => {}, first.body.access_token);
  await runSmoke(`${h.origin}/mcp`, () => {}, second.body.access_token);
  await connectionPost(h, b.browser, "disconnect");
  await assert.rejects(
    runSmoke(`${h.origin}/mcp`, () => {}, first.body.access_token),
  );
});

test("controlled signing key overlap, retirement and empty allowlist deny old access", async (t) => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { generateKeyPair, exportJWK, decodeProtectedHeader } = await import(
    "jose"
  );
  const h = await harness(t),
    a = await authorize(h),
    old = await exchange(h, a);
  await h.stop();
  const bundle = JSON.parse(readFileSync(h.keyFile));
  const pair = await generateKeyPair("RS256", { extractable: true });
  const next = {
    ...(await exportJWK(pair.privateKey)),
    kid: "synthetic-two",
    use: "sig",
    alg: "RS256",
  };
  bundle.signing = [next, ...bundle.signing];
  writeFileSync(h.keyFile, JSON.stringify(bundle));
  await h.start();
  await runSmoke(`${h.origin}/mcp`, () => {}, old.body.access_token);
  const b = await authorize(h),
    newToken = await exchange(h, b);
  assert.equal(
    decodeProtectedHeader(newToken.body.access_token).kid,
    "synthetic-two",
  );
  await h.stop();
  bundle.signing = [next];
  writeFileSync(h.keyFile, JSON.stringify(bundle));
  await h.start();
  await assert.rejects(
    runSmoke(`${h.origin}/mcp`, () => {}, old.body.access_token),
  );
  await runSmoke(`${h.origin}/mcp`, () => {}, newToken.body.access_token);
  await h.stop();
  h.env.FIXTURE_ALLOWED_PLAN_IDS = "[]";
  await h.start();
  await assert.rejects(
    runSmoke(`${h.origin}/mcp`, () => {}, newToken.body.access_token),
    /NO_SMOKE_PLAN/,
  );
});

test("discovery advertises enabled endpoints; unsupported grants and registrations are unavailable", async (t) => {
  const h = await harness(t);
  const m = await (
    await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)
  ).json();
  assert.equal(m.resource, `${h.origin}/mcp`);
  assert.deepEqual(m.authorization_servers, [h.origin]);
  const d = await (
    await fetch(`${h.origin}/.well-known/oauth-authorization-server`)
  ).json();
  assert.equal(d.issuer, h.origin);
  assert(d.code_challenge_methods_supported.includes("S256"));
  assert(!d.grant_types_supported.includes("refresh_token"));
  assert(!d.registration_endpoint);
  for (const path of ["/reg", "/registration", "/introspection", "/revocation"])
    assert.equal((await fetch(`${h.origin}${path}`)).status, 404);
  const a = await authorize(h),
    r = await exchange(h, a);
  assert.equal(r.body.refresh_token, undefined);
  const noResource = await fetch(`${h.origin}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "synthetic-native",
      code: "synthetic",
    }),
  });
  assert.equal(noResource.status, 400);
});
