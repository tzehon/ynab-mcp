import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Enrollment } from "../dist/oauth/enrollment.js";
import { HostedLifecycle } from "../dist/oauth/hosted-lifecycle.js";
import { providerHarness } from "./helpers/hosted-provider.mjs";
const owner = "11111111-1111-4111-8111-111111111111";
const config = () => ({
  kind: "enroll",
  issuance: "fixture-issuance",
  capability: randomBytes(32).toString("hex"),
  expires: Date.now() + 900000,
});
test("enrollment claims once, binds browser, discards tokens and stays closed after disconnect", async (t) => {
  const h = await providerHarness(t),
    c = config(),
    e = new Enrollment(h.store, c);
  const flow = e.claim(c.capability, "browser");
  assert.throws(() => e.claim(c.capability, "browser"));
  assert.throws(() => e.candidate(flow, "other", owner));
  e.candidate(flow, "browser", owner);
  assert.equal(e.inspectCandidate(), owner);
  assert.throws(() => e.confirm("22222222-2222-4222-8222-222222222222"));
  e.confirm(owner);
  assert.equal(e.inspectCandidate(), undefined);
  assert.throws(() => new Enrollment(h.store, c));
  assert.equal(
    new Enrollment(h.store, { kind: "owner", owner }).status(),
    "confirmed",
  );
  h.store.clearHostedAuthorization();
  assert.equal(
    new Enrollment(h.store, { kind: "owner", owner }).status(),
    "confirmed",
  );
  assert.throws(() => new Enrollment(h.store, c));
  assert.equal(h.store.get("Connection", owner), undefined);
});
test("enrollment attempt count survives construction and cannot reset the same issuance", async (t) => {
  const h = await providerHarness(t),
    c = config();
  for (let i = 0; i < 5; i++)
    assert.throws(() => new Enrollment(h.store, c).claim("wrong", "browser"));
  assert.throws(() =>
    new Enrollment(h.store, c).claim(c.capability, "browser"),
  );
  assert.equal(h.store.get("Enrollment", "current").attempts, 5);
  assert.throws(
    () => new Enrollment(h.store, { ...c, capability: "f".repeat(64) }),
  );
});
test("upstream refresh is single-flight, preserves enrollment, and cannot resurrect disconnect", async (t) => {
  const h = await providerHarness(t);
  let calls = 0,
    release;
  const upstream = {
    refresh: async () => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    },
  };
  const lifecycle = new HostedLifecycle(h.store, upstream, owner);
  lifecycle.connect(
    {
      access: "invented",
      refresh: "invented-refresh",
      expires: Date.now() + 30000,
    },
    owner,
  );
  const first = lifecycle.refresh(),
    second = lifecycle.refresh();
  assert.equal(calls, 1);
  release({
    access: "next",
    refresh: "next-refresh",
    expires: Date.now() + 3600000,
  });
  await Promise.all([first, second]);
  lifecycle.check();
  assert.equal(calls, 1);
  const current = lifecycle.current();
  h.store.put(
    "Connection",
    owner,
    { ...current, tokens: { ...current.tokens, expires: Date.now() + 1 } },
    Number.MAX_SAFE_INTEGER,
  );
  const race = lifecycle.refresh();
  lifecycle.disconnect();
  release({ access: "lost", refresh: "lost", expires: Date.now() + 3600000 });
  await assert.rejects(race);
  assert.throws(() => lifecycle.check());
  assert.equal(h.store.get("Connection", owner), undefined);
  lifecycle.connect(
    {
      access: "reconnected",
      refresh: "reconnected",
      expires: Date.now() + 3600000,
    },
    owner,
  );
  lifecycle.check();
});
test("ambiguous provider failure and interrupted startup require reconnect", async (t) => {
  const h = await providerHarness(t);
  let calls = 0;
  const l = new HostedLifecycle(
    h.store,
    {
      refresh: async () => {
        calls++;
        throw Error("invented failure");
      },
    },
    owner,
  );
  l.connect(
    {
      access: "invented",
      refresh: "invented-refresh",
      expires: Date.now() + 1000,
    },
    owner,
  );
  await assert.rejects(l.refresh());
  assert.equal(calls, 1);
  assert.equal(l.current(), undefined);
  h.store.put(
    "Connection",
    owner,
    {
      status: "refreshing",
      generation: "old",
      operation: "interrupted",
      tokens: { access: "old", refresh: "old", expires: 0 },
    },
    Number.MAX_SAFE_INTEGER,
  );
  const resumed = new HostedLifecycle(
    h.store,
    {
      refresh: async () => {
        throw Error("must not retry");
      },
    },
    owner,
  );
  assert.equal(resumed.current(), undefined);
  assert.throws(() => resumed.check());
});

test("expired upstream blocks admission without network and storage failure cannot fake disconnect", async (t) => {
  const h = await providerHarness(t);
  let calls = 0,
    now = Date.now();
  h.store.now = () => now;
  const lifecycle = new HostedLifecycle(
    h.store,
    {
      refresh: async () => {
        calls++;
        return { access: "renewed", refresh: "kept", expires: now + 3600000 };
      },
    },
    owner,
  );
  lifecycle.connect(
    { access: "fixture", refresh: "kept", expires: now + 1000 },
    owner,
  );
  now += 1001;
  assert.throws(() => lifecycle.check());
  assert.equal(calls, 0);
  await lifecycle.refresh();
  lifecycle.check();
  assert.equal(calls, 1);
  h.store.close();
  assert.throws(() => lifecycle.disconnect());
  assert.throws(() => lifecycle.ready());
  assert.throws(() => lifecycle.check());
  assert.equal(calls, 1);
});
