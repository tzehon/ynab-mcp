import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import test from "node:test";
import { adapterFor } from "../dist/oauth/adapter.js";
import { seal, unseal } from "../dist/oauth/crypto.js";
import { Store } from "../dist/oauth/store.js";

function setup(t) {
  const dir = realpathSync(mkdtempSync("/tmp/ynab-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = { encryption: randomBytes(32), lookup: randomBytes(32) };
  return { dir, keys };
}
test("encrypted records survive restart; no payload or raw identifier in database artifacts", (t) => {
  const { dir, keys } = setup(t);
  let s = new Store(dir, keys);
  s.put("Grant", "CANARY-ID", { token: "CANARY-TOKEN" }, Date.now() + 60000);
  s.close();
  s = new Store(dir, keys);
  assert.equal(s.get("Grant", "CANARY-ID").token, "CANARY-TOKEN");
  for (const file of readdirSync(dir)) {
    const data = readFileSync(`${dir}/${file}`);
    assert(!data.includes("CANARY-TOKEN"));
    assert(!data.includes("CANARY-ID"));
  }
  s.close();
});
test("two adapters consume a code at most once, replay insert conflicts and grant revocation removes linked records", async (t) => {
  const { dir, keys } = setup(t);
  const a = new Store(dir, keys),
    b = new Store(dir, keys);
  t.after(() => {
    a.close();
    b.close();
  });
  const A = adapterFor(a),
    B = adapterFor(b),
    x = new A("AuthorizationCode"),
    y = new B("AuthorizationCode");
  await x.upsert("code", { grantId: "g" }, 60);
  const result = await Promise.allSettled([
    x.consume("code"),
    y.consume("code"),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert((await x.find("code")).consumed);
  const r = new A("ReplayDetection");
  await r.upsert("r", {}, 60);
  await assert.rejects(r.upsert("r", {}, 60));
  await x.revokeByGrantId("g");
  assert.equal(await y.find("code"), undefined);
});
test("expiry, rollback and wrong keys fail closed", (t) => {
  const { dir, keys } = setup(t);
  let now = 100000;
  const s = new Store(dir, keys, () => now);
  s.put("x", "id", { v: 1 }, now + 100);
  assert.throws(() =>
    s.transaction(() => {
      s.put("x", "id", { v: 2 }, now + 100);
      throw Error();
    }),
  );
  assert.equal(s.get("x", "id").v, 1);
  now += 101;
  assert.equal(s.get("x", "id"), undefined);
  s.close();
  assert.throws(() => new Store(dir, { ...keys, encryption: randomBytes(32) }));
});
test("ciphertext and AAD tampering rejected; insecure paths rejected", (t) => {
  const { dir, keys } = setup(t);
  const data = seal(keys.encryption, "aad", { secret: 1 });
  assert.throws(() => unseal(keys.encryption, "other", data));
  data[15] ^= 1;
  assert.throws(() => unseal(keys.encryption, "aad", data));
  chmodSync(dir, 0o755);
  assert.throws(() => new Store(dir, keys));
});
test("payload and record budgets do not evict active authorization", (t) => {
  const { dir, keys } = setup(t);
  const s = new Store(dir, keys);
  t.after(() => s.close());
  assert.throws(() =>
    s.put("x", "huge", { s: "x".repeat(65536) }, Date.now() + 60000),
  );
  for (let i = 0; i < 999; i++)
    s.put("x", String(i), { v: i }, Date.now() + 60000);
  assert.throws(() => s.put("x", "extra", {}, Date.now() + 60000));
  assert.equal(s.get("x", "0").v, 0);
  s.clearAuthorization();
  assert.equal(s.count(), 1);
});

test("unknown schema, corrupt ciphertext and lock contention fail closed", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { dir, keys } = setup(t);
  let s = new Store(dir, keys);
  s.put("Grant", "g", { secret: "canary" }, Date.now() + 60000);
  s.close();
  let raw = new DatabaseSync(`${dir}/authorization.sqlite`);
  raw.exec("UPDATE records SET payload=zeroblob(40) WHERE model='Grant'");
  raw.close();
  s = new Store(dir, keys);
  assert.throws(() => s.get("Grant", "g"));
  raw = new DatabaseSync(`${dir}/authorization.sqlite`);
  raw.exec("BEGIN IMMEDIATE");
  assert.throws(() => s.put("Grant", "other", {}, Date.now() + 60000));
  raw.exec("ROLLBACK");
  s.close();
  raw.exec("PRAGMA user_version=99");
  raw.close();
  assert.throws(() => new Store(dir, keys));
});

test("physical storage ceiling rejects growth while revocation remains possible", (t) => {
  const { dir, keys } = setup(t),
    s = new Store(dir, keys);
  t.after(() => s.close());
  let rejected = false;
  for (let i = 0; i < 600; i++) {
    try {
      s.put(
        "Grant",
        String(i),
        { data: "x".repeat(62000) },
        Date.now() + 60000,
      );
    } catch {
      rejected = true;
      break;
    }
  }
  assert(rejected);
  s.clearAuthorization();
  assert.equal(s.count(), 1);
});
