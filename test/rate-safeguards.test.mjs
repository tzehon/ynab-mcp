import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisCache } from "../dist/ynab/analysis-cache.js";
import { RequestBudget } from "../dist/ynab/request-budget.js";
import { Store } from "../dist/oauth/store.js";
import { ToolError } from "../dist/tools/errors.js";
import { deferred, code } from "./helpers/ynab-http.mjs";

const check = () => {};
test("snapshot reuse preserves exact facts, absolute TTL, defensive copies and refresh invalidation", async () => {
  let now = 1000,
    calls = 0;
  const c = new AnalysisCache(() => now);
  const work = async () => ({
    amount: ++calls,
    as_of: "original",
    digest: "original",
  });
  const get = (refresh = false) =>
    c.get("key", refresh, undefined, check, work);
  const a = await get();
  a.value.amount = 100;
  now += 119999;
  const b = await get();
  assert.equal(b.value.amount, 1);
  assert.equal(b.started, 1000);
  assert.equal(b.expires, 121000);
  assert.equal(b.reused, true);
  now++;
  assert.equal((await get()).value.amount, 2);
  assert.equal((await get(true)).value.amount, 3);
  await assert.rejects(
    c.get("key", true, undefined, check, async () => {
      throw new ToolError("UPSTREAM_RATE_LIMITED");
    }),
    code("UPSTREAM_RATE_LIMITED"),
  );
  assert.equal((await get()).value.amount, 4);
  c.clear();
});

test("cache retains at most four entries, misses differing arguments and does not retain failures", async () => {
  const c = new AnalysisCache();
  let calls = 0;
  const work = async () => ++calls;
  for (let i = 0; i < 5; i++)
    await c.get(String(i), false, undefined, check, work);
  await c.get("1", false, undefined, check, work);
  assert.equal(calls, 5);
  await c.get("0", false, undefined, check, work);
  assert.equal(calls, 6);
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      c.get("fail", false, undefined, check, async () => {
        calls++;
        throw Error("failure");
      }),
    );
  assert.equal(calls, 8);
  c.clear();
});

test("identical concurrent readers share work; one cancellation does not cancel the survivor", async () => {
  const c = new AnalysisCache(),
    gate = deferred(),
    controller = new AbortController();
  let calls = 0,
    workerSignal;
  const work = async (signal) => {
    calls++;
    workerSignal = signal;
    return gate.promise;
  };
  const first = c.get("key", false, controller.signal, check, work);
  const rejected = assert.rejects(first, code("UPSTREAM_TIMEOUT"));
  const second = c.get("key", false, undefined, check, work);
  await Promise.resolve();
  await assert.rejects(
    c.get("key", true, undefined, check, work),
    code("BUSY"),
  );
  controller.abort();
  await rejected;
  assert.equal(workerSignal.aborted, false);
  gate.resolve({ amount: 3 });
  assert.equal((await second).value.amount, 3);
  assert.equal(calls, 1);
  c.clear();
});

test("all waiters cancelled or cleared cannot populate cache; revoked waiter never receives data", async () => {
  const c = new AnalysisCache(),
    gate = deferred(),
    controller = new AbortController();
  let calls = 0;
  const work = async () => {
    calls++;
    return gate.promise;
  };
  const first = c.get("key", false, controller.signal, check, work);
  const rejection = assert.rejects(first, code("UPSTREAM_TIMEOUT"));
  await Promise.resolve();
  controller.abort();
  await rejection;
  gate.resolve(1);
  await new Promise(setImmediate);
  assert.equal(
    (
      await c.get("key", false, undefined, check, async () => {
        calls++;
        return 2;
      })
    ).value,
    2,
  );
  assert.equal(calls, 2);
  const pending = deferred();
  let permitted = true;
  const read = c.get(
    "other",
    false,
    undefined,
    () => {
      if (!permitted) throw new ToolError("UPSTREAM_UNAUTHORIZED");
    },
    () => pending.promise,
  );
  const denied = assert.rejects(read, code("UPSTREAM_UNAUTHORIZED"));
  await Promise.resolve();
  permitted = false;
  pending.resolve(5);
  await denied;
  permitted = true;
  assert.equal(
    (await c.get("other", false, undefined, check, async () => 6)).value,
    6,
  );
  c.clear();
});

test("cache enforces pending bound and clear aborts workers without repopulation", async () => {
  const c = new AnalysisCache(),
    gate = deferred();
  const reads = Array.from({ length: 4 }, (_, i) =>
    assert.rejects(
      c.get(String(i), false, undefined, check, () => gate.promise),
      code("UPSTREAM_TIMEOUT"),
    ),
  );
  await Promise.resolve();
  await assert.rejects(
    c.get("fifth", false, undefined, check, async () => 1),
    code("BUSY"),
  );
  c.clear();
  gate.resolve(4);
  await Promise.all(reads);
  assert.equal(
    (await c.get("0", false, undefined, check, async () => 5)).value,
    5,
  );
  c.clear();
});

test("durable rolling budget counts dispatched failures, survives restart and disconnect, and expires exactly", (t) => {
  let now = 10000000;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ynab-quota-")));
  const keys = { encryption: randomBytes(32), lookup: randomBytes(32) };
  let store = new Store(dir, keys, () => now);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let budget = new RequestBudget(store, "owner");
  for (let i = 0; i < 200; i++) budget.admit();
  assert.throws(() => budget.admit(), code("UPSTREAM_RATE_LIMITED"));
  store.clearHostedAuthorization();
  store.close();
  store = new Store(dir, keys, () => now);
  budget = new RequestBudget(store, "owner");
  now += 3599999;
  assert.throws(() => budget.admit(), code("UPSTREAM_RATE_LIMITED"));
  now++;
  budget.admit();
  budget.limited();
  now += 3599999;
  assert.throws(
    () => new RequestBudget(store, "owner").admit(),
    code("UPSTREAM_RATE_LIMITED"),
  );
  now++;
  budget.admit();
  assert.deepEqual(
    Object.keys(store.get("YnabRequestBudget", "owner")).sort(),
    ["attempts", "blockedUntil"],
  );
});

test("malformed quota state fails closed before dispatch", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ynab-quota-bad-")));
  const store = new Store(dir, {
    encryption: randomBytes(32),
    lookup: randomBytes(32),
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put(
    "YnabRequestBudget",
    "owner",
    { attempts: "invalid" },
    Date.now() + 3600000,
  );
  assert.throws(
    () => new RequestBudget(store, "owner").admit(),
    code("UPSTREAM_FAILURE"),
  );
});
