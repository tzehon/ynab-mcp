import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt } from "jose";
import { providerHarness } from "./helpers/hosted-provider.mjs";
import { Store } from "../dist/oauth/store.js";
import { RefreshFamilies } from "../dist/oauth/refresh-families.js";
import {
  hostedPolicy,
  IDLE_SECONDS,
  ABSOLUTE_SECONDS,
} from "../dist/oauth/hosted-policy.js";

for (const client of ["native", "web"])
  test(`hosted engine: OAuth-only explicit offline consent and rotation (${client})`, async (t) => {
    const h = await providerHarness(t),
      a = await h.authorize({ client });
    assert.equal(a.consents, 1);
    assert.equal(a.params.get("iss"), h.origin);
    assert.ok(a.params.get("code"));
    const r = await h.exchange(a);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id_token, undefined);
    assert.ok(r.body.refresh_token);
    const jwt = decodeJwt(r.body.access_token);
    assert.equal(jwt.aud, h.resource);
    assert.equal(jwt.sub, "synthetic-owner");
    const refresh = () =>
      h.token({
        grant_type: "refresh_token",
        client_id: client,
        refresh_token: r.body.refresh_token,
        ...(client === "web"
          ? { client_secret: "synthetic-client-secret-for-engine-probe" }
          : {}),
      });
    const next = await refresh();
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.notEqual(next.body.refresh_token, r.body.refresh_token);
    assert.equal(decodeJwt(next.body.access_token).aud, h.resource);
    assert.ok(
      h.events.indexOf("authenticated-family") <
        h.events.indexOf("RefreshToken:consume"),
    );
    assert.equal(h.events.at(-1), "finalized");
    assert.equal((await refresh()).status, 400);
    assert.equal(h.families.get(jwt.grant_id).status, "revoked");
  });

test("hosted engine: no offline request means no refresh; prompt none rejected", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize({ scope: "ynab:read" });
  const r = await h.exchange(a);
  assert.equal(r.status, 200);
  assert.equal(r.body.refresh_token, undefined);
  const denied = await h.authorize({ prompt: "none" });
  assert.equal(denied.status, 400);
  assert.equal(denied.consents, 0);
});

test("hosted engine: authenticated cross-client rejection cannot revoke a family", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize(),
    r = await h.exchange(a),
    id = decodeJwt(r.body.access_token).grant_id;
  const bad = await h.token({
    grant_type: "refresh_token",
    client_id: "web",
    client_secret: "synthetic-client-secret-for-engine-probe",
    refresh_token: r.body.refresh_token,
  });
  assert.equal(bad.status, 400);
  assert.equal(h.families.get(id).status, "active");
  const valid = await h.token({
    grant_type: "refresh_token",
    client_id: "native",
    refresh_token: r.body.refresh_token,
  });
  assert.equal(valid.status, 200);
});

for (const fault of ["faultSave", "faultFinalize"])
  test(`hosted engine: ${fault} withholds usable credentials`, async (t) => {
    const h = await providerHarness(t),
      a = await h.authorize(),
      r = await h.exchange(a),
      id = decodeJwt(r.body.access_token).grant_id;
    h[fault]();
    const next = await h.token({
      grant_type: "refresh_token",
      client_id: "native",
      refresh_token: r.body.refresh_token,
    });
    assert.notEqual(next.status, 200);
    assert.equal(next.body.access_token, undefined);
    assert.equal(h.families.get(id).status, "revoked");
  });

test("hosted engine: disconnect before finalization denies response", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize(),
    r = await h.exchange(a);
  h.beforeFinalize((id) => h.families.revoke(id));
  const next = await h.token({
    grant_type: "refresh_token",
    client_id: "native",
    refresh_token: r.body.refresh_token,
  });
  assert.equal(next.status, 400);
  assert.equal(next.body.access_token, undefined);
});

test("hosted engine: simultaneous reuse invalidates the response still being finalized", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize(),
    r = await h.exchange(a),
    id = decodeJwt(r.body.access_token).grant_id;
  let arrived, release;
  const started = new Promise((r) => {
    arrived = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  let first = true;
  h.beforeFinalize(async () => {
    if (first) {
      first = false;
      arrived();
      await gate;
    }
  });
  const send = () =>
    h.token({
      grant_type: "refresh_token",
      client_id: "native",
      refresh_token: r.body.refresh_token,
    });
  const winner = send();
  await started;
  try {
    assert.equal((await send()).status, 400);
  } finally {
    release();
  }
  assert.equal((await winner).status, 400);
  assert.equal(h.families.get(id).status, "revoked");
});

test("hosted engine: restart invalidates unfinished durable reservation", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize(),
    r = await h.exchange(a),
    id = decodeJwt(r.body.access_token).grant_id;
  h.families.reserve(id, "native", "synthetic-owner", false, false);
  h.store.close();
  const reopened = new Store(h.dir, h.keys);
  t.after(() => reopened.close());
  const recovered = new RefreshFamilies(reopened, () => "synthetic-generation");
  assert.equal(recovered.get(id).status, "revoked");
  assert.throws(() =>
    recovered.check(id, "native", "synthetic-owner", h.resource),
  );
});

test("hosted engine: idle and absolute expiry and independent family", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize(),
    r = await h.exchange(a),
    id = decodeJwt(r.body.access_token).grant_id;
  const other = await h.exchange(await h.authorize({ client: "web" })),
    otherId = decodeJwt(other.body.access_token).grant_id;
  const payload = [...h.rows].find(([k]) => k.startsWith("RefreshToken:"))[1];
  assert.equal(payload.exp - payload.iat, IDLE_SECONDS);
  assert.notEqual(payload.expiresWithSession, true);
  const f = h.families.get(id);
  h.store.put(
    "RefreshFamily",
    id,
    { ...f, used: Date.now() - IDLE_SECONDS * 1000 },
    f.deadline,
  );
  assert.throws(() =>
    h.families.reserve(id, "native", "synthetic-owner", false, false),
  );
  assert.equal(h.families.get(id).status, "revoked");
  assert.equal(h.families.get(otherId).status, "active");
  const ttl = hostedPolicy(h.resource).ttl.RefreshToken,
    now = Math.floor(Date.now() / 1000);
  assert.ok(ttl({}, { iiat: now - ABSOLUTE_SECONDS + 60 }) <= 60);
  assert.equal(ttl({}, { iiat: now - ABSOLUTE_SECONDS - 1 }), 0);
  const b = new h.Browser();
  for (const path of ["/reg", "/introspection", "/revocation", "/me"])
    assert.equal((await b.fetch(path)).status, 404);
});

test("hosted engine: expired consumed member still revokes its live family only after authentication", async (t) => {
  const h = await providerHarness(t),
    a = await h.authorize({ client: "web" }),
    r = await h.exchange(a);
  const id = decodeJwt(r.body.access_token).grant_id;
  const next = await h.token({
    grant_type: "refresh_token",
    client_id: "web",
    client_secret: "synthetic-client-secret-for-engine-probe",
    refresh_token: r.body.refresh_token,
  });
  assert.equal(next.status, 200);
  const previous = h.store.get("RefreshToken", r.body.refresh_token),
    family = h.families.get(id);
  h.store.put(
    "RefreshToken",
    r.body.refresh_token,
    { ...previous, exp: Math.floor(Date.now() / 1000) - 1 },
    family.deadline,
    { grantId: id },
  );
  // No expired-row cleanup may discard this family's replay evidence.
  h.store.cleanup();
  assert(h.store.get("RefreshToken", r.body.refresh_token));
  const bad = await h.token({
    grant_type: "refresh_token",
    client_id: "web",
    client_secret: "wrong",
    refresh_token: r.body.refresh_token,
  });
  assert.equal(bad.body.error, "invalid_client");
  assert.equal(h.families.get(id).status, "active");
  const replay = await h.token({
    grant_type: "refresh_token",
    client_id: "web",
    client_secret: "synthetic-client-secret-for-engine-probe",
    refresh_token: r.body.refresh_token,
  });
  assert.equal(replay.status, 400);
  assert.equal(h.families.get(id).status, "revoked");
  assert.throws(() =>
    h.families.check(id, "web", "synthetic-owner", h.resource),
  );
});
