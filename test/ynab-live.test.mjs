import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { Store } from "../dist/oauth/store.js";
import { HostedLifecycle } from "../dist/oauth/hosted-lifecycle.js";
import { LiveService } from "../dist/ynab/live-service.js";
import { authorizationContext } from "../dist/auth/authorization-context.js";
import { parseConfig } from "../dist/config.js";
import { fixtureEnv } from "./helpers/auth.mjs";
import { mapped, other, deferred, code } from "./helpers/ynab-http.mjs";
import { fixtureDocuments } from "../dist/fixtures/ynab.js";
import { listAccounts } from "../dist/tools/list-accounts.js";
import { getMonth } from "../dist/tools/get-month.js";
import { listCategories } from "../dist/tools/list-categories.js";
import { listTransactions } from "../dist/tools/list-transactions.js";

const plan = { id: mapped, name: "PRIVATE_PLAN_CANARY", currency_code: "SGD" };
const catalog = {
  data: {
    plans: [
      {
        id: mapped,
        name: plan.name,
        currency_format: { iso_code: "SGD" },
        accounts: ["IGNORED_FINANCIAL_CANARY"],
      },
    ],
  },
};
const account = () => Response.json(fixtureDocuments[mapped].accounts);
function setup(t, fetcher = async () => account(), refresh) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ynab-live-"))),
    store = new Store(dir, {
      encryption: randomBytes(32),
      lookup: randomBytes(32),
    });
  const life = new HostedLifecycle(
    store,
    { refresh: refresh ?? (() => assert.fail("unexpected refresh")) },
    "owner",
  );
  life.connect(
    {
      access: "UPSTREAM_TOKEN_CANARY",
      refresh: "REFRESH_CANARY",
      expires: Date.now() + 3600000,
    },
    "owner",
  );
  const live = new LiveService(parseConfig(fixtureEnv), store, life, fetcher);
  t.after(() => {
    live.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const select = (ids = [mapped]) =>
    live.select(life.generation(), [plan], ids);
  const authorized = (work) =>
    authorizationContext.run(() => life.check(), work);
  return { dir, store, life, live, select, authorized };
}

test("live reads require request authorization and selected plans before network", async (t) => {
  let hits = 0;
  const { live, select, authorized } = setup(t, async () => {
    hits++;
    return account();
  });
  assert.throws(() => live.plans(), code("UPSTREAM_UNAUTHORIZED"));
  await assert.rejects(
    live.run((c) => listAccounts(c, { plan_id: mapped })),
    code("UPSTREAM_UNAUTHORIZED"),
  );
  assert.equal(authorized(() => live.plans()).plans.length, 0);
  await assert.rejects(
    authorized(() => live.run((c) => listAccounts(c, { plan_id: mapped }))),
    code("PLAN_NOT_ALLOWED"),
  );
  select();
  for (const id of [other, "fixture-plan-sgd"])
    await assert.rejects(
      authorized(() => live.run((c) => listAccounts(c, { plan_id: id }))),
      code(
        id === "fixture-plan-sgd" ? "INVALID_ARGUMENTS" : "PLAN_NOT_ALLOWED",
      ),
    );
  assert.equal(hits, 0);
  assert.equal(authorized(() => live.plans()).plans[0].id, mapped);
});

test("live five-tool projections and selected metadata are truthful and encrypted", async (t) => {
  const seen = [];
  const { live, select, authorized, store, dir } = setup(
    t,
    async (url, init) => {
      seen.push(url);
      assert.equal(init.headers.Authorization, "Bearer UPSTREAM_TOKEN_CANARY");
      const tail = new URL(url).pathname.split("/")[4];
      return Response.json(
        fixtureDocuments[mapped][tail === "months" ? "month" : tail],
      );
    },
  );
  select();
  assert.equal(authorized(() => live.plans()).data_mode, "live");
  assert.equal(seen.length, 0);
  for (const [fn, args] of [
    [listAccounts, {}],
    [listCategories, {}],
    [getMonth, { month: "2026-11-01" }],
    [listTransactions, { since_date: "2026-11-01", until_date: "2026-11-07" }],
  ]) {
    const result = await authorized(() =>
      live.run((c) => fn(c, { plan_id: mapped, ...args })),
    );
    assert.equal(result.structuredContent.data_mode, "live");
    assert.equal(result.structuredContent.source, "ynab");
    assert.equal(result.structuredContent.plan_id, mapped);
    assert(!JSON.stringify(result).includes("TOKEN_CANARY"));
  }
  assert.equal(seen.length, 4);
  assert.deepEqual(Object.keys(store.get("PlanSelection", "owner")).sort(), [
    "generation",
    "plans",
    "version",
  ]);
  const bytes = Buffer.concat([
    readFileSync(`${dir}/authorization.sqlite`),
    readFileSync(`${dir}/authorization.sqlite-wal`),
  ]).toString();
  for (const marker of [
    plan.name,
    "UPSTREAM_TOKEN_CANARY",
    mapped,
    "REFRESH_CANARY",
  ])
    assert(!bytes.includes(marker));
});

for (const action of ["selection", "disconnect", "family", "expiry", "close"])
  test(`live pending response is discarded after ${action} change`, async (t) => {
    const entered = deferred(),
      reply = deferred();
    const { live, life, select } = setup(t, async () => {
      entered.resolve();
      return reply.promise;
    });
    select();
    let allowed = true;
    const work = authorizationContext.run(
      () => {
        if (!allowed) throw Error("REVOKED_CANARY");
        life.check();
      },
      () => live.run((c) => listAccounts(c, { plan_id: mapped })),
    );
    const rejected = assert.rejects(
      work,
      (e) => !!e.code && !String(e).includes("CANARY"),
    );
    await entered.promise;
    if (action === "selection") select([]);
    else if (action === "disconnect") life.disconnect();
    else if (action === "close") live.close();
    else allowed = false;
    reply.resolve(account());
    await rejected;
  });

test("near-expiry concurrent reads share exactly one refresh", async (t) => {
  let refreshes = 0,
    gets = 0;
  const gate = deferred();
  const { live, life, select } = setup(
    t,
    async () => {
      gets++;
      return account();
    },
    async () => {
      refreshes++;
      await gate.promise;
      return {
        access: "NEW_CANARY",
        refresh: "NEW_REFRESH",
        expires: Date.now() + 3600000,
      };
    },
  );
  life.connect(
    {
      access: "OLD_CANARY",
      refresh: "OLD_REFRESH",
      expires: Date.now() + 30000,
    },
    "owner",
  );
  select();
  // Minimal verified grant closure isolates upstream serialization here; full auth pipeline tested separately.
  const read = () =>
    authorizationContext.run(
      () => {},
      () => live.run((c) => listAccounts(c, { plan_id: mapped })),
    );
  const a = read(),
    b = read();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(refreshes, 1);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(gets, 2);
});

test("cancelled refresh waiter cannot dispatch late; ambiguous refresh disconnects", async (t) => {
  let gets = 0;
  const gate = deferred(),
    entered = deferred();
  const { live, life, select } = setup(
    t,
    async () => {
      gets++;
      return account();
    },
    async () => {
      entered.resolve();
      return gate.promise;
    },
  );
  life.connect(
    { access: "OLD", refresh: "REFRESH", expires: Date.now() + 30000 },
    "owner",
  );
  select();
  const abort = new AbortController();
  const work = authorizationContext.run(
    () => {},
    () => live.run((c) => listAccounts(c, { plan_id: mapped }, abort.signal)),
  );
  const denied = assert.rejects(work, code("UPSTREAM_TIMEOUT"));
  await entered.promise;
  abort.abort();
  await denied;
  gate.reject(Error("PROVIDER_CANARY"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gets, 0);
  assert.equal(life.current(), undefined);
});

test("catalog fixed GET validates bounded metadata and selection rejects tampering", async (t) => {
  const { live, life, store } = setup(t, async (url, init) => {
    assert.equal(url, "https://api.ynab.com/v1/plans");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    return Response.json(catalog);
  });
  const found = await live.discover();
  assert.deepEqual(found.plans, [plan]);
  for (const ids of [[other], [mapped, mapped], Array(11).fill(mapped)])
    assert.throws(() => live.select(found.generation, found.plans, ids));
  live.select(found.generation, found.plans, [mapped]);
  assert(
    !JSON.stringify(store.get("PlanSelection", "owner")).includes(
      "IGNORED_FINANCIAL",
    ),
  );
  life.disconnect();
  assert.equal(store.get("PlanSelection", "owner"), undefined);
  assert.throws(() => live.select(found.generation, found.plans, [mapped]));
});

for (const bad of [
  null,
  { data: { plans: [{ id: mapped, name: "x" }] } },
  { data: { plans: [catalog.data.plans[0], catalog.data.plans[0]] } },
  { data: { plans: Array(101).fill(catalog.data.plans[0]) } },
])
  test("invalid catalog fails closed without persisting data", async (t) => {
    const { live, store } = setup(t, async () => Response.json(bad));
    await assert.rejects(live.discover(), code("UPSTREAM_INVALID_RESPONSE"));
    assert.equal(store.get("PlanSelection", "owner"), undefined);
  });

test("late catalog after disconnect cannot recreate metadata", async (t) => {
  const entered = deferred(),
    gate = deferred();
  const { live, life, store } = setup(t, async () => {
    entered.resolve();
    return gate.promise;
  });
  const work = live.discover(),
    denied = assert.rejects(work);
  await entered.promise;
  life.disconnect();
  gate.resolve(Response.json(catalog));
  await denied;
  assert.equal(store.count(), 1);
});
