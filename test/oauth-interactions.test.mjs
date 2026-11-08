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
    verifier,
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
  const policy = f.headers.get("content-security-policy");
  const formAction = policy
    .split(";")
    .find((part) => part.trim().startsWith("form-action"));
  assert.equal(
    formAction.trim(),
    `form-action 'self' ${h.mock.origin} ${new URL(h.env.OAUTH_NATIVE_CALLBACK).origin}`,
  );
  assert(!policy.includes("*"));
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

async function complete(h, flow, callback) {
  let r = await flow.b.fetch(callback ?? (await upstreamCallback(flow)));
  for (let i = 0; i < 8 && r.headers.has("location"); i++) {
    const location = new URL(r.headers.get("location"), h.origin).href;
    if (location.startsWith(h.env.OAUTH_NATIVE_CALLBACK)) {
      const result = await exchange(h, {
        params: new URL(location).searchParams,
        callback: h.env.OAUTH_NATIVE_CALLBACK,
        verifier: flow.verifier,
      });
      assert.equal(result.status, 200);
      return result.body.access_token;
    }
    r = await flow.b.fetch(location);
  }
  assert.fail(`completion status ${r.status}`);
}
for (const pendingCallback of [false, true]) {
  test(`both tabs finish after one establishes an owner session; callback pending=${pendingCallback}`, async (t) => {
    const h = await harness(t),
      b = new Browser(),
      first = await begin(h, b),
      second = await begin(h, b);
    const binding = b.cookies.get("127.0.0.1:/:oauth_local").value;
    const secondCallback = pendingCallback
      ? await upstreamCallback(second)
      : undefined;
    const firstToken = await complete(h, first);
    const firstOwner = b.cookies.get("127.0.0.1:/:oauth_owner").value;
    const secondToken = await complete(h, second, secondCallback);
    assert.equal(b.cookies.get("127.0.0.1:/:oauth_local").value, binding);
    assert.notEqual(b.cookies.get("127.0.0.1:/:oauth_owner").value, firstOwner);
    assert.equal((await b.fetch(`${h.origin}/connection`)).status, 200);
    for (const token of [firstToken, secondToken]) {
      assert.equal(
        (
          await fetch(`${h.origin}/mcp`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        405,
      );
    }
    const old = new Browser();
    old.cookies.set("owner", {
      host: "127.0.0.1",
      path: "/",
      name: "oauth_owner",
      value: firstOwner,
    });
    assert.equal((await old.fetch(`${h.origin}/connection`)).status, 400);
    assert.equal(h.mock.counts.exchange, 2);
  });
}
test("unrecognized browser binding is replaced and cannot become an owner session", async (t) => {
  const h = await harness(t),
    b = new Browser(),
    fixed = randomBytes(32).toString("base64url");
  b.cookies.set("127.0.0.1:/:oauth_local", {
    host: "127.0.0.1",
    path: "/",
    name: "oauth_local",
    value: fixed,
  });
  const flow = await begin(h, b),
    binding = b.cookies.get("127.0.0.1:/:oauth_local").value;
  assert.notEqual(binding, fixed);
  await complete(h, flow);
  const owner = b.cookies.get("127.0.0.1:/:oauth_owner").value;
  assert.notEqual(owner, binding);
  b.cookies.delete("127.0.0.1:/:oauth_owner");
  assert.equal((await b.fetch(`${h.origin}/connection`)).status, 400);
});

test("no-referrer browser form requires same-origin navigation plus CSRF and binding", async (t) => {
  const h = await harness(t),
    f = await begin(h);
  const headers = {
    origin: "null",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "content-type": "application/x-www-form-urlencoded",
  };
  // Node fetch owns sec-fetch-mode; use raw HTTP for the browser-shaped request.
  const { request } = await import("node:http");
  const send = (url, changes = {}, csrf = f.csrf, cookies = true) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            ...headers,
            ...(cookies
              ? {
                  cookie: [...f.b.cookies.values()]
                    .map((c) => `${c.name}=${c.value}`)
                    .join("; "),
                }
              : {}),
            ...changes,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(new URLSearchParams({ csrf, decision: "continue" }).toString());
    });
  for (const changes of [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none" },
    { "sec-fetch-mode": "cors" },
    { "sec-fetch-dest": "empty" },
    { origin: "http://evil.invalid" },
  ]) {
    assert.equal(await send(f.url, changes), 403);
  }
  assert.equal(await send(`${h.origin}/mcp`), 403);
  assert.equal(await send(f.url, {}, "wrong"), 400);
  assert.equal(await send(f.url, {}, f.csrf, false), 400);
  assert.equal(await send(f.url), 303);
  assert.equal(await send(f.url), 400);
});

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`two upstream consent pages finish independently in order ${order}`, async (t) => {
    const h = await harness(t),
      b = new Browser(),
      flows = [await begin(h, b), await begin(h, b)],
      forms = [];
    for (const flow of flows) {
      const go = await flow.submit(),
        url = go.headers.get("location"),
        r = await b.fetch(url),
        text = await r.text();
      forms.push({
        url,
        csrf: text.match(/name="csrf" value="([^"]+)"/)[1],
        flow_id: text.match(/name="flow_id" value="([^"]+)"/)[1],
      });
    }
    const submit = (form, browser = b) =>
      browser.fetch(form.url, {
        method: "POST",
        headers: {
          origin: h.mock.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ ...form, decision: "allow" }),
      });
    assert.equal(
      (await submit({ ...forms[0], flow_id: forms[1].flow_id })).status,
      400,
    );
    assert.equal((await submit(forms[0], new Browser())).status, 400);
    for (const i of order) {
      const r = await submit(forms[i]);
      assert.equal(r.status, 303);
      await complete(h, flows[i], r.headers.get("location"));
      assert.equal((await submit(forms[i])).status, 400);
    }
    assert.equal(h.mock.counts.exchange, 2);
    assert.equal((await b.fetch(`${h.origin}/connection`)).status, 200);
  });
}
