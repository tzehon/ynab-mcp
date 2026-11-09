import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import {
  readFileSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { hostedApp } from "./helpers/hosted-app.mjs";
import { hostedKeys } from "../dist/oauth/hosted-keys.js";
import { RefreshFamilies } from "../dist/oauth/refresh-families.js";
import { providerHarness } from "./helpers/hosted-provider.mjs";
import {
  decodeJwt,
  decodeProtectedHeader,
  generateKeyPair,
  exportJWK,
} from "jose";

const post = (browser, path, origin, values, headers = {}) =>
  browser.fetch(path, {
    method: "POST",
    headers: {
      ...(path === "/token" ? {} : { origin }),
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(values).toString(),
  });
const csrf = (r) => r.text.match(/name="csrf" value="([^"]+)"/)[1];
function admin(path, input) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let data = "";
    socket.setTimeout(3000, () => socket.destroy(Error("timeout")));
    socket.on("error", reject);
    socket.on("data", (b) => (data += b));
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("connect", () => socket.end(JSON.stringify(input) + "\n"));
  });
}

test("closed HTTP enrollment requires capability, browser and private exact confirmation; no tokens survive", async (t) => {
  const { h, e, runtime, dir, owner, seen, raw } = await hostedApp(t, {
    bootstrap: true,
  });
  const b = new h.Browser(),
    stranger = new h.Browser();
  for (const path of ["/mcp", "/auth", "/token", "/connection"])
    assert.equal((await b.fetch(path)).status, 403);
  const metadata = (
    await b.fetch("/.well-known/oauth-authorization-server")
  ).json();
  assert.equal(metadata.issuer, h.origin);
  assert(metadata.scopes_supported.includes("offline_access"));
  const form = await b.fetch("/enroll");
  assert.equal(form.status, 200);
  assert.match(form.text, /<title>MCP Tools for YNAB<\/title>/);
  assert.match(form.text, /href="\/privacy"/);
  assert.equal(
    (
      await post(stranger, "/enroll", h.origin, {
        csrf: csrf(form),
        capability: e.OAUTH_ENROLLMENT_CAPABILITY,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(b, "/enroll", "null", {
        csrf: csrf(form),
        capability: e.OAUTH_ENROLLMENT_CAPABILITY,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        b,
        "/enroll",
        "null",
        { csrf: csrf(form), capability: e.OAUTH_ENROLLMENT_CAPABILITY },
        {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      )
    ).status,
    403,
  );
  let r = await post(
    b,
    "/enroll",
    "null",
    { csrf: csrf(form), capability: e.OAUTH_ENROLLMENT_CAPABILITY },
    {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  );
  assert.equal(r.status, 303);
  const url = new URL(r.headers.location);
  assert.equal(url.origin, "https://app.ynab.com");
  assert.equal(url.searchParams.get("scope"), "read-only");
  const callback = `/connect/ynab/callback?${new URLSearchParams({ code: "invented-code", state: url.searchParams.get("state") })}`;
  assert.equal((await stranger.fetch(callback)).status, 400);
  assert.equal(seen.length, 0);
  r = await b.fetch(callback);
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /Awaiting operator confirmation/);
  assert(!r.text.includes(owner));
  assert.equal((await b.fetch(callback)).status, 400);
  assert.equal(seen.length, 2);
  assert.equal(
    (await admin(join(runtime, "admin.sock"), { command: "candidate" }))
      .candidate,
    owner,
  );
  assert.equal(
    (
      await admin(join(runtime, "admin.sock"), {
        command: "confirm",
        owner: "22222222-2222-4222-8222-222222222222",
      })
    ).error,
    "ADMIN_REJECTED",
  );
  assert.equal(
    (
      await admin(join(runtime, "admin.sock"), {
        command: "sql",
        sql: "select 1",
      })
    ).error,
    "ADMIN_REJECTED",
  );
  assert.deepEqual(
    await admin(join(runtime, "admin.sock"), { command: "confirm", owner }),
    { confirmed: true },
  );
  assert.deepEqual(
    await admin(join(runtime, "admin.sock"), { command: "candidate" }),
    {},
  );
  assert.equal((await b.fetch("/mcp")).status, 403);
  for (const name of ["authorization.sqlite", "authorization.sqlite-wal"]) {
    const bytes = readFileSync(join(dir, name));
    for (const canary of [
      owner,
      "invented-upstream-access",
      "invented-upstream-refresh",
      e.OAUTH_ENROLLMENT_CAPABILITY,
      JSON.parse(raw).encryption,
    ])
      assert(!bytes.includes(Buffer.from(canary)));
  }
});

for (const method of ["client_secret_post", "client_secret_basic"])
  test(`production consent negatives and exact ${method} authentication do not issue credentials`, async (t) => {
    const { h, e, control, seen } = await hostedApp(t, { method });
    const b = new h.Browser(),
      verifier = randomBytes(32).toString("base64url");
    const params = {
      client_id: e.OAUTH_WEB_CLIENT_ID,
      redirect_uri: e.OAUTH_WEB_CALLBACK,
      response_type: "code",
      scope: "ynab:read offline_access",
      resource: `${h.origin}/mcp`,
      state: "fixture-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    };
    const begin = async (overrides) =>
      b.fetch(`/auth?${new URLSearchParams({ ...params, ...overrides })}`);
    for (const overrides of [
      { redirect_uri: "https://attacker.example/callback" },
      { client_id: "unknown" },
      { resource: "https://attacker.example/mcp" },
      { scope: "openid ynab:read" },
      { prompt: "none" },
      { code_challenge_method: "plain" },
    ]) {
      const r = await begin(overrides);
      assert(
        r.status >= 400 ||
          (r.headers.location &&
            !r.headers.location.startsWith("https://attacker.example")),
      );
      assert(!r.text.includes("access_token"));
    }
    let r = await begin(),
      path = r.headers.location;
    r = await b.fetch(path);
    r = await post(b, path, h.origin, { csrf: csrf(r), decision: "deny" });
    for (let i = 0; i < 5 && r.headers.location?.startsWith(h.origin); i++)
      r = await b.fetch(r.headers.location);
    const denied = new URL(r.headers.location);
    assert.equal(denied.searchParams.get("error"), "access_denied");
    assert.equal(denied.searchParams.get("iss"), h.origin);
    assert.equal(seen.length, 0);
    r = await begin();
    path = r.headers.location;
    r = await b.fetch(path);
    const approval = { csrf: csrf(r), decision: "continue" };
    assert.equal(
      (await post(b, path, "https://attacker.example", approval)).status,
      403,
    );
    r = await post(b, path, h.origin, approval);
    assert.equal(r.status, 303);
    assert.equal((await post(b, path, h.origin, approval)).status, 400);
    control.owner = "22222222-2222-4222-8222-222222222222";
    const upstream = new URL(r.headers.location);
    r = await b.fetch(
      `/connect/ynab/callback?${new URLSearchParams({ code: "invented-code", state: upstream.searchParams.get("state") })}`,
    );
    assert.equal(r.status, 400);
    assert.equal((await b.fetch("/connection")).status, 400);
    const values = {
      grant_type: "refresh_token",
      client_id: e.OAUTH_WEB_CLIENT_ID,
      refresh_token: "invented",
    };
    const wrong =
      method === "client_secret_basic"
        ? {
            values: { ...values, client_secret: e.OAUTH_WEB_SECRET },
            headers: {},
          }
        : {
            values,
            headers: {
              authorization: `Basic ${Buffer.from(`${e.OAUTH_WEB_CLIENT_ID}:${e.OAUTH_WEB_SECRET}`).toString("base64")}`,
            },
          };
    assert.equal(
      (await post(b, "/token", h.origin, wrong.values, wrong.headers)).status,
      400,
    );
    for (const path of [
      "/reg",
      "/userinfo",
      "/introspection",
      "/device/auth",
      "/revoke",
    ])
      assert.equal((await b.fetch(path)).status, 404);
  });

test("undelivered token finalization is unusable and revoked on restart", async (t) => {
  const h = await providerHarness(t),
    f = h.families;
  f.create("pending-delivery", "native", "synthetic-owner", h.resource);
  const op = f.reserve(
    "pending-delivery",
    "native",
    "synthetic-owner",
    true,
    false,
  );
  f.finish(op, true);
  assert.throws(() =>
    f.check(op.family, "native", "synthetic-owner", h.resource),
  );
  const restarted = new RefreshFamilies(h.store, () => "synthetic-generation");
  assert.equal(restarted.get(op.family).status, "revoked");
  assert.throws(() =>
    restarted.check(op.family, "native", "synthetic-owner", h.resource),
  );
});

test("key preparation writes only a new private file with no stdout or overwrite", (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ynab-key-preparation-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fixture-keys.json"),
    run = () =>
      spawnSync(process.execPath, ["scripts/prepare-hosted-keys.mjs", path], {
        encoding: "utf8",
      });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const before = readFileSync(path, "utf8");
  hostedKeys(before);
  assert.equal(run().status, 1);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("raw production HTTP rejects duplicate authority and forwarding cannot alter discovery", async (t) => {
  const { h, app } = await hostedApp(t);
  const authority = new URL(h.origin).host;
  const raw = (target, headers) =>
    new Promise((resolve, reject) => {
      const socket = connect({
        host: "127.0.0.1",
        port: app.server.address().port,
      });
      let out = "";
      socket.setTimeout(3000, () => socket.destroy(Error("timeout")));
      socket.on("error", reject);
      socket.on("data", (c) => (out += c));
      socket.on("end", () => resolve(out));
      socket.on("connect", () =>
        socket.end(
          `GET ${target} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`,
        ),
      );
    });
  for (const [target, headers] of [
    ["/mcp", `Host: ${authority}\r\nHost: ${authority}`],
    [
      "/mcp",
      `Host: ${authority}\r\nOrigin: ${h.origin}\r\nOrigin: ${h.origin}`,
    ],
    [
      "/mcp",
      `Host: ${authority}\r\nAuthorization: Bearer a\r\nAuthorization: Bearer b`,
    ],
    ["//evil.example/mcp", `Host: ${authority}`],
    ["/auth", "Host: healthcheck.railway.app"],
  ])
    assert.match(await raw(target, headers), /^HTTP\/1.1 (400|403)/);
  const b = new h.Browser(),
    r = await b.fetch("/.well-known/oauth-authorization-server", {
      headers: {
        forwarded: "host=evil.example;proto=http",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });
  assert.equal(r.status, 200);
  assert.equal(r.json().issuer, h.origin);
  assert.equal(r.json().authorization_endpoint, `${h.origin}/auth`);
});

test("full record capacity cannot release a successor or evict consumed replay evidence", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize(),
    issued = await h.exchange(a);
  assert.equal(issued.status, 200);
  const family = decodeJwt(issued.body.access_token).grant_id;
  for (let i = 0; h.store.count() < 1000; i++)
    h.store.put("Capacity", String(i), {}, Date.now() + 60000);
  const r = await h.token({
    grant_type: "refresh_token",
    client_id: "native",
    refresh_token: issued.body.refresh_token,
  });
  assert.equal(r.status, 400);
  assert(!r.body.access_token);
  assert.equal(h.families.get(family).status, "revoked");
  assert.throws(() =>
    h.families.check(family, "native", "synthetic-owner", h.resource),
  );
  assert(h.store.get("RefreshToken", issued.body.refresh_token));
});

test("hosted concurrent tabs finish independently in either order and replay loses authority", async (t) => {
  const { h, e, seen, restart, raw } = await hostedApp(t),
    b = new h.Browser();
  const begin = async (client) => {
    const verifier = randomBytes(32).toString("base64url"),
      redirect =
        client === e.OAUTH_NATIVE_CLIENT_ID
          ? e.OAUTH_NATIVE_CALLBACK
          : e.OAUTH_WEB_CALLBACK;
    let r = await b.fetch(
      `/auth?${new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code", scope: "ynab:read offline_access", resource: `${h.origin}/mcp`, state: client, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`,
    );
    const path = r.headers.location;
    r = await b.fetch(path);
    assert.equal(r.status, 200);
    return { client, verifier, redirect, path, csrf: csrf(r) };
  };
  const finish = async (a) => {
    let r = await post(b, a.path, h.origin, {
      csrf: a.csrf,
      decision: "continue",
    });
    assert.equal(r.status, 303);
    const url = new URL(r.headers.location);
    r = await b.fetch(
      `/connect/ynab/callback?${new URLSearchParams({ state: url.searchParams.get("state"), code: "invented-code" })}`,
    );
    for (let i = 0; i < 5 && r.headers.location?.startsWith(h.origin); i++)
      r = await b.fetch(r.headers.location);
    const callback = new URL(r.headers.location);
    assert.equal(callback.searchParams.get("state"), a.client);
    r = await post(b, "/token", h.origin, {
      grant_type: "authorization_code",
      client_id: a.client,
      redirect_uri: a.redirect,
      code: callback.searchParams.get("code"),
      code_verifier: a.verifier,
      resource: `${h.origin}/mcp`,
      ...(a.client === e.OAUTH_WEB_CLIENT_ID
        ? { client_secret: e.OAUTH_WEB_SECRET }
        : {}),
    });
    assert.equal(r.status, 200, r.text);
    return r.json();
  };
  const valid = async (access) =>
    (
      await b.fetch("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      })
    ).status;
  for (const reverse of [false, true]) {
    const native = await begin(e.OAUTH_NATIVE_CLIENT_ID),
      web = await begin(e.OAUTH_WEB_CLIENT_ID);
    const ordered = reverse ? [web, native] : [native, web],
      tokens = [];
    for (const a of ordered) tokens.push(await finish(a));
    await restart();
    for (const tok of tokens) assert.equal(await valid(tok.access_token), 200);
    const a = ordered[0],
      values = {
        grant_type: "refresh_token",
        client_id: a.client,
        refresh_token: tokens[0].refresh_token,
        ...(a.client === e.OAUTH_WEB_CLIENT_ID
          ? { client_secret: e.OAUTH_WEB_SECRET }
          : {}),
      };
    const next = await post(b, "/token", h.origin, values);
    assert.equal(next.status, 200);
    assert.equal((await post(b, "/token", h.origin, values)).status, 400);
    assert.equal(await valid(next.json().access_token), 401);
    assert.equal(await valid(tokens[1].access_token), 200);
  }
  const before = await finish(await begin(e.OAUTH_NATIVE_CLIENT_ID));
  const original = JSON.parse(raw),
    old = original.signing[0],
    { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const newKey = {
    ...(await exportJWK(privateKey)),
    kid: "fixture-rotated",
    alg: "RS256",
    use: "sig",
  };
  const deadline = Date.now() + 2000;
  await restart({
    keyBundle: JSON.stringify({
      ...original,
      signing: [newKey],
      retiring: {
        kty: old.kty,
        n: old.n,
        e: old.e,
        kid: old.kid,
        alg: old.alg,
        use: old.use,
      },
      retiringUntil: deadline,
    }),
  });
  assert.equal(await valid(before.access_token), 200);
  const after = await finish(await begin(e.OAUTH_NATIVE_CLIENT_ID));
  assert.equal(
    decodeProtectedHeader(after.access_token).kid,
    "fixture-rotated",
  );
  await new Promise((r) =>
    setTimeout(r, Math.max(1, deadline - Date.now() + 20)),
  );
  assert.equal(await valid(before.access_token), 401);
  assert.equal(await valid(after.access_token), 200);
  assert.deepEqual(
    (await b.fetch("/jwks")).json().keys.map((k) => k.kid),
    ["fixture-rotated"],
  );
  const clean = join(h.root, "clean-recovery");
  (await import("node:fs")).mkdirSync(clean, { mode: 0o700 });
  await restart({
    dir: clean,
    enrollment: {
      kind: "enroll",
      issuance: "fixture-recovery",
      capability: randomBytes(32).toString("hex"),
      expires: Date.now() + 900000,
    },
  });
  assert.equal(await valid(after.access_token), 403);
  assert.equal((await b.fetch("/enroll")).status, 200);
  assert(
    seen.every((url) =>
      [
        "https://app.ynab.com/oauth/token",
        "https://api.ynab.com/v1/user",
      ].includes(url),
    ),
  );
});
