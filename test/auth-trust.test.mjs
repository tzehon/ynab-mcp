import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK } from "jose";
import { KeyStore } from "../dist/auth/key-store.js";
import { Authenticator } from "../dist/auth/verifier.js";
import {
  discovery,
  keySet,
  decode,
  fixtureTransport,
} from "../dist/auth/contracts.js";
import { parseConfig } from "../dist/config.js";
import { fixtureEnv, bundle, jwk, sign } from "./helpers/auth.mjs";
const signal = () => new AbortController().signal;
test("discovery and key schemas reject hostile trust data", () => {
  discovery(bundle.discovery);
  keySet(bundle.jwks);
  for (const change of [
    { issuer: "https://issuer.example.test" },
    { jwks_uri: "https://evil.test/jwks" },
    { authorization_endpoint: "https://issuer.example.test.evil.test/a" },
    { token_endpoint: "https://issuer.example.test/token?x" },
    { code_challenge_methods_supported: [] },
    { response_types_supported: [] },
  ])
    assert.throws(() => discovery({ ...bundle.discovery, ...change }));
  for (const value of [
    { keys: [] },
    { keys: Array(9).fill(jwk) },
    { keys: [jwk, jwk] },
    ...Object.entries({
      d: "secret",
      k: "secret",
      kty: "oct",
      alg: "HS256",
      use: "enc",
      kid: "",
      n: "AQAB",
      e: "!",
      key_ops: ["sign"],
    }).map(([k, v]) => ({ keys: [{ ...jwk, [k]: v }] })),
  ])
    assert.throws(() => keySet(value));
  for (const r of [
    { status: 302, contentType: "application/json", body: "{}" },
    { status: 200, contentType: "text/html", body: "{}" },
    { status: 200, contentType: "application/json", body: "x".repeat(65537) },
    { status: 200, contentType: "application/json", body: "{" },
  ])
    assert.throws(() => decode(r));
});
test("rotation, removed keys, freshness, failed refresh and global cooldown", async (t) => {
  let clock = 0,
    calls = 0,
    fail = false;
  const second = {
    ...(await exportJWK((await generateKeyPair("RS256")).publicKey)),
    alg: "RS256",
    use: "sig",
    kid: "rotated",
  };
  let keys = [jwk];
  const store = new KeyStore(
    async (request) => {
      calls++;
      if (fail) throw new Error("SECRET");
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          request.url.endsWith("openid-configuration")
            ? bundle.discovery
            : { keys },
        ),
      };
    },
    () => clock,
  );
  t.after(() => store.close());
  await store.resolve(jwk.kid, signal());
  assert.equal(calls, 2);
  await store.resolve(jwk.kid, signal());
  assert.equal(calls, 2);
  for (let i = 0; i < 20; i++)
    await assert.rejects(store.resolve(`unknown-${i}`, signal()));
  assert.equal(calls, 2);
  clock = 5000;
  keys = [second];
  await store.resolve(second.kid, signal());
  assert.equal(calls, 3);
  await assert.rejects(store.resolve(jwk.kid, signal()));
  clock = 10000;
  fail = true;
  await assert.rejects(store.resolve("unknown", signal()));
  assert.equal(calls, 4);
  await store.resolve(second.kid, signal());
  assert.equal(calls, 4);
  clock = 65000;
  await assert.rejects(store.resolve(second.kid, signal()));
  assert.equal(calls, 5);
  clock = 70000;
  fail = false;
  await store.resolve(second.kid, signal());
  assert.equal(calls, 7);
});
test("concurrent unknown keys coalesce and cancellation fences late cache writes", async (t) => {
  let release,
    calls = 0,
    clock = 0;
  const base = fixtureTransport(bundle);
  const store = new KeyStore(
    async (req, s) => {
      calls++;
      if (calls === 1)
        await new Promise((r) => {
          release = r;
        });
      return base(req, s);
    },
    () => clock,
  );
  t.after(() => store.close());
  const a = new AbortController(),
    b = new AbortController();
  const one = store.resolve(jwk.kid, a.signal),
    two = store.resolve(jwk.kid, b.signal);
  a.abort();
  await assert.rejects(one);
  release();
  await two;
  assert.equal(calls, 2);
  clock = 60000;
  const bad = new KeyStore(
    async () => {
      calls++;
      await new Promise((r) => {
        release = r;
      });
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bundle.discovery),
      };
    },
    () => clock,
  );
  const c = new AbortController();
  const waiting = bad.resolve(jwk.kid, c.signal);
  c.abort();
  await assert.rejects(waiting);
  bad.close();
  release();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(bad.resolve(jwk.kid, signal()));
});
test("four-operation admission and real timeout keep physical refresh bounded", {
  timeout: 6000,
}, async (t) => {
  let calls = 0,
    release;
  const config = parseConfig(fixtureEnv).auth;
  const a = new Authenticator(config, async () => {
    calls++;
    await new Promise((r) => {
      release = r;
    });
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(bundle.discovery),
    };
  });
  t.after(() => a.close());
  const another = new Authenticator(config, fixtureTransport(bundle));
  t.after(() => another.close());
  const header = `Bearer ${await sign(config.audience)}`;
  const pending = Array.from({ length: 4 }, () =>
    a.authenticate(header, signal()),
  );
  await assert.rejects(
    another.authenticate(header, signal()),
    (e) => e.kind === "unavailable",
  );
  const started = performance.now();
  const results = await Promise.allSettled(pending);
  assert.ok(
    results.every(
      (r) => r.status === "rejected" && r.reason.kind === "unavailable",
    ),
  );
  assert.ok(performance.now() - started < 2600);
  assert.equal(calls, 1);
  for (let i = 0; i < 20; i++)
    await assert.rejects(a.authenticate(header, signal()));
  assert.equal(calls, 1);
  release();
  await new Promise((r) => setImmediate(r));
  await another.authenticate(header, signal());
  a.close();
});
