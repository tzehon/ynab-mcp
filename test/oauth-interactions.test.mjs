import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadKeys } from "../dist/oauth/keys.js";
import { Store } from "../dist/oauth/store.js";
import {
  authorize,
  Browser,
  exchange,
  harness,
} from "./helpers/integrated-auth.mjs";

async function begin(h, b = new Browser()) {
  const verifier = randomBytes(32).toString("base64url"),
    q = new URLSearchParams({
      client_id: "synthetic-native",
      redirect_uri: h.env.OAUTH_NATIVE_CALLBACK,
      response_type: "code",
      scope: "ynab:read",
      resource: `${h.origin}/mcp`,
      state: "downstream",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
  const start = await b.fetch(`${h.origin}/auth?${q}`),
    url = new URL(start.headers.get("location"), h.origin).href,
    r = await b.fetch(url),
    text = await r.text(),
    csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert(csrf);
  return {
    b,
    url,
    csrf,
    headers: r.headers,
    async submit(extra = {}, browser = b) {
      return browser.fetch(url, {
        method: "POST",
        headers: {
          origin: h.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf, decision: "continue", ...extra }),
      });
    },
  };
}
async function upstreamCallback(f) {
  const go = await f.submit();
  const r = await f.b.form(go.headers.get("location"), "allow");
  return r.headers.get("location");
}
test("consent enforces CSRF, session, header policy and single-use submission", async (t) => {
  const h = await harness(t),
    f = await begin(h);
  assert.equal(f.headers.get("cache-control"), "no-store");
  assert.equal(f.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    f.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.match(f.headers.get("set-cookie"), /HttpOnly.*SameSite=Lax/);
  assert.equal((await f.submit({ csrf: "wrong" })).status, 400);
  assert.equal((await f.submit({}, new Browser())).status, 400);
  assert.equal((await f.submit()).status, 303);
  assert.equal((await f.submit()).status, 400);
  assert.equal(h.mock.counts.exchange, 0);
});
test("upstream state cannot be substituted, replayed or moved to another browser", async (t) => {
  const h = await harness(t),
    f = await begin(h),
    callback = await upstreamCallback(f);
  const wrong = new URL(callback);
  wrong.searchParams.set("state", "wrong");
  assert.equal((await f.b.fetch(wrong)).status, 400);
  assert.equal((await new Browser().fetch(callback)).status, 400);
  assert.equal(h.mock.counts.exchange, 0);
  assert.equal((await f.b.fetch(callback)).status, 303);
  assert.equal((await f.b.fetch(callback)).status, 400);
  assert.equal(h.mock.counts.exchange, 1);
});
test("expired state and changed interaction cannot issue a code", async (t) => {
  const h = await harness(t),
    f = await begin(h),
    callback = await upstreamCallback(f);
  const db = new DatabaseSync(`${h.dir}/authorization.sqlite`);
  db.exec("UPDATE records SET expires=0 WHERE model='UpstreamState'");
  db.close();
  assert.equal((await f.b.fetch(callback)).status, 400);
  assert.equal(h.mock.counts.exchange, 0);
  assert.equal((await f.b.fetch(`${h.origin}/interaction/other`)).status, 400);
});
test("concurrent tabs remain bound to their own interaction; consent is required again", async (t) => {
  const h = await harness(t),
    b = new Browser(),
    a = await begin(h, b),
    c = await begin(h, b);
  assert.notEqual(a.csrf, c.csrf);
  assert.equal((await a.submit({ csrf: c.csrf })).status, 400);
  assert.equal((await c.submit()).status, 303);
  assert.equal((await a.submit()).status, 303);
  const login = await authorize(h);
  const again = await begin(h, login.browser);
  assert(again.csrf);
  assert.equal(h.mock.counts.exchange, 1);
});
test("upstream denial and duplicate callback parameters fail without credential issuance", async (t) => {
  const h = await harness(t);
  h.mock.controls.deny = true;
  await assert.rejects(authorize(h), /FLOW_400/);
  assert.equal(h.mock.counts.user, 0);
  h.mock.controls.deny = false;
  const f = await begin(h),
    callback = await upstreamCallback(f),
    u = new URL(callback);
  u.searchParams.append("state", "other");
  assert.equal((await f.b.fetch(u)).status, 400);
});
test("body/query limits fail closed", async (t) => {
  const h = await harness(t);
  assert.equal(
    (
      await fetch(`${h.origin}/token`, {
        method: "POST",
        body: new URLSearchParams({ secret: "CANARY".repeat(3000) }),
      })
    ).status,
    400,
  );
  const r = await fetch(`${h.origin}/auth?q=${"x".repeat(8500)}`);
  assert(r.status >= 400);
  const texts = await r.text();
  assert(!texts.includes("CANARY"));
});
test("revoked/tampered grant associations cannot authorize signed MCP tokens", async (t) => {
  const h = await harness(t),
    a = await authorize(h),
    tok = await exchange(h, a);
  const s = new Store(h.dir, loadKeys(h.keyFile, h.dir));
  const claim = JSON.parse(
    Buffer.from(tok.body.access_token.split(".")[1], "base64url"),
  );
  s.put(
    "McpGrant",
    claim.grant_id,
    { owner: h.env.AUTH_ALLOWED_SUBJECT, client: "other", generation: "wrong" },
    Date.now() + 5000,
  );
  s.close();
  assert.equal(
    (
      await fetch(`${h.origin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok.body.access_token}` },
      })
    ).status,
    401,
  );
});
