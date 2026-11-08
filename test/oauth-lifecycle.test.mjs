import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import test from "node:test";
import { Lifecycle } from "../dist/oauth/lifecycle.js";
import { Store } from "../dist/oauth/store.js";

function setup(t, upstream) {
  const dir = realpathSync(mkdtempSync("/tmp/ynab-life-")),
    keys = { encryption: randomBytes(32), lookup: randomBytes(32) },
    store = new Store(dir, keys);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, life: new Lifecycle(store, upstream, "owner"), dir, keys };
}
const expired = { access: "old-access", refresh: "old-refresh", expires: 1 };
test("concurrent refresh exchanges once and persists replacement", async (t) => {
  let calls = 0;
  const { life } = setup(t, {
    refresh: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        ...expired,
        refresh: "replacement",
        expires: Date.now() + 10000,
      };
    },
  });
  life.connect(expired);
  await Promise.all([life.refresh(), life.refresh()]);
  assert.equal(calls, 1);
  assert.equal(life.current().tokens.refresh, "replacement");
});
test("disconnect wins delayed refresh and old tokens cannot be committed", async (t) => {
  let release;
  const { life } = setup(t, {
    refresh: () => new Promise((r) => (release = r)),
  });
  life.connect(expired);
  const p = life.refresh();
  life.disconnect();
  release({ ...expired, refresh: "new" });
  await assert.rejects(p);
  assert.equal(life.current(), undefined);
});
test("ambiguous refresh failure requires reconnect; crash marker never replays", async (t) => {
  const { life, store } = setup(t, {
    refresh: async () => {
      throw Error("synthetic");
    },
  });
  life.connect(expired);
  await assert.rejects(life.refresh());
  assert.equal(life.current(), undefined);
  const c = life.connect(expired);
  store.put(
    "Connection",
    "owner",
    { ...c, status: "refreshing", operation: "crashed" },
    Number.MAX_SAFE_INTEGER,
  );
  const recovered = new Lifecycle(
    store,
    { refresh: async () => assert.fail("replayed") },
    "owner",
  );
  assert.equal(recovered.current(), undefined);
});
test("grant-state association gates owner, client, generation and disconnection", (t) => {
  const { life, store } = setup(t, {});
  const c = life.connect(expired);
  store.put(
    "McpGrant",
    "g",
    { owner: "owner", client: "client", generation: c.generation },
    Date.now() + 10000,
  );
  const claims = { sub: "owner", client_id: "client", grant_id: "g" };
  life.checkGrant(claims);
  for (const invalid of [
    { ...claims, sub: "other" },
    { ...claims, client_id: "other" },
    { ...claims, grant_id: "missing" },
  ])
    assert.throws(() => life.checkGrant(invalid));
  life.disconnect();
  assert.throws(() => life.checkGrant(claims));
  life.connect(expired);
  assert.throws(() => life.checkGrant(claims));
});
