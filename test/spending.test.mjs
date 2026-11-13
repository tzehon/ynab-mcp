import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../dist/config.js";
import {
  fixtureDocuments,
  fixtureTransport,
  mockResponse,
} from "../dist/fixtures/ynab.js";
import { MockYnabClient } from "../dist/ynab/client.js";
import { AdmissionBudget } from "../dist/ynab/limits.js";
import { getSpendingReport } from "../dist/tools/get-spending-report.js";
import { listTransactions } from "../dist/tools/list-transactions.js";
import { fixtureEnv } from "./helpers/server.mjs";
const plan_id = "fixture-plan-sgd",
  month = "2026-11-01";
const args = { plan_id, month };
const window = {
  plan_id,
  since_date: month,
  until_date: "2026-11-30",
  limit: 100,
};
const uid = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const code = (expected) => (e) => e.code === expected;
function docs() {
  return structuredClone(
    fixtureDocuments["11111111-1111-4111-8111-111111111111"],
  );
}
function client(d = docs(), hook = () => {}, budget = new AdmissionBudget()) {
  let calls = 0;
  const c = new MockYnabClient(
    parseConfig(fixtureEnv),
    async (r, s) => {
      calls++;
      const kind = r.path.includes("/months/")
        ? "month"
        : r.path.split("/").at(-1);
      const copy = structuredClone(d[kind]);
      await hook(kind, copy, calls, r, s);
      return mockResponse(copy);
    },
    budget,
  );
  return { c, calls: () => calls };
}
async function report(d, hook) {
  return (await getSpendingReport(client(d, hook).c, args)).structuredContent;
}
function addCategory(
  d,
  n,
  name,
  activity,
  {
    groupName = "Invented second group",
    internal = false,
    groupInternal = false,
    hidden = false,
  } = {},
) {
  const c = {
    ...d.month.data.month.categories[0],
    id: uid(n),
    category_group_id: uid(n + 100),
    name,
    activity,
    internal,
    hidden,
  };
  const g = {
    id: c.category_group_id,
    name: groupName,
    hidden,
    internal: groupInternal,
    deleted: false,
    categories: [structuredClone(c)],
  };
  const existing = d.categories.data.category_groups.find(
    (x) => x.name === groupName && x.internal === groupInternal,
  );
  if (existing) {
    c.category_group_id = existing.id;
    existing.categories.push(structuredClone(c));
  } else d.categories.data.category_groups.push(g);
  d.month.data.month.categories.push(c);
  d.month.data.month.activity += activity;
  return c;
}
function tx(d, id, amount, category_id, extra = {}) {
  const base = d.transactions.data.transactions[0];
  d.transactions.data.transactions.push({
    ...base,
    id,
    amount,
    category_id,
    ...extra,
  });
}

test("spending counts split children once, includes closed tracking transfer explicitly, excludes tracking side/deleted rows", async () => {
  const r = await report();
  assert.deepEqual(r.totals, {
    gross_outflow_milliunits: 24500,
    category_credit_milliunits: 0,
    net_spending_milliunits: 24500,
    categorized_transfer_net_milliunits: 9000,
  });
  assert.equal(r.coverage.spending_line_count, 4);
  assert.equal(r.coverage.excluded_tracking_line_count, 1);
  assert.equal(r.reconciliation.difference_milliunits, 0);
  assert.equal(r.complete, true);
  assert.equal(r.period_closed, false);
});
test("payment bookkeeping is separated, credits remain negative spending, income and budget transfers excluded", async () => {
  const d = docs(),
    baseCat = d.month.data.month.categories[0];
  addCategory(d, 2, "Invented card", -40000, {
    groupName: "Credit Card Payments",
    groupInternal: true,
  });
  const credit = addCategory(d, 3, "Invented credits", 12000, { hidden: true });
  const income = addCategory(d, 4, "Inflow: Ready to Assign", 0, {
    groupName: "Internal Master Category",
    internal: true,
    groupInternal: true,
  });
  tx(d, "credit", 12000, credit.id);
  tx(d, "income", 500000, income.id);
  const a = { ...d.accounts.data.accounts[0], id: uid(9), closed: true };
  d.accounts.data.accounts.push(a);
  tx(d, "budget-transfer", -10000, null, { transfer_account_id: a.id });
  tx(d, "budget-transfer-other", 10000, null, {
    account_id: a.id,
    transfer_account_id: d.accounts.data.accounts[0].id,
  });
  tx(d, "closed-purchase", -2000, baseCat.id, { account_id: a.id });
  baseCat.activity -= 2000;
  d.month.data.month.activity -= 2000;
  const r = await report(d);
  assert.equal(r.totals.net_spending_milliunits, 14500);
  assert.equal(r.totals.gross_outflow_milliunits, 26500);
  assert.equal(r.totals.category_credit_milliunits, 12000);
  assert.equal(
    r.categories.find((c) => c.id === credit.id).net_spending_milliunits,
    -12000,
  );
  assert.equal(r.categories.find((c) => c.id === credit.id).hidden, true);
  assert.equal(r.reconciliation.payment_category_activity_milliunits, -40000);
  assert.equal(r.reconciliation.budget_activity_milliunits, -54500);
  assert.equal(r.coverage.excluded_income_line_count, 1);
  assert.equal(r.coverage.excluded_budget_transfer_line_count, 2);
});
test("uncategorized is explicit; user categories named like system categories remain spending", async () => {
  const d = docs();
  addCategory(d, 2, "Uncategorized", -500, {
    groupName: "Internal Master Category",
    internal: true,
    groupInternal: true,
  });
  const user = addCategory(d, 3, "Inflow: Ready to Assign", -700);
  tx(d, "uncategorized", -500, null);
  tx(d, "user-category", -700, user.id);
  assert.equal((await report(d)).totals.net_spending_milliunits, 25700);
});
test("zero spending is a reconciled result, not a missing-period substitution", async () => {
  const d = docs();
  d.transactions.data.transactions = [];
  d.month.data.month.activity = 0;
  d.month.data.month.categories[0].activity = 0;
  const r = await report(d);
  assert.equal(r.totals.net_spending_milliunits, 0);
  assert.equal(r.complete, true);
});
for (const [label, edit] of [
  ["category difference", (d) => d.month.data.month.categories[0].activity--],
  ["month difference", (d) => d.month.data.month.activity--],
  [
    "split difference",
    (d) => d.transactions.data.transactions[1].subtransactions[0].amount--,
  ],
  [
    "split parent mismatch",
    (d) =>
      (d.transactions.data.transactions[1].subtransactions[0].transaction_id =
        "wrong"),
  ],
  [
    "duplicate transaction",
    (d) =>
      d.transactions.data.transactions.push(
        d.transactions.data.transactions[0],
      ),
  ],
  [
    "duplicate category",
    (d) => d.month.data.month.categories.push(d.month.data.month.categories[0]),
  ],
  ["missing category", (d) => (d.categories.data.category_groups = [])],
  ["missing account", (d) => (d.accounts.data.accounts = [])],
  ["deleted account", (d) => (d.accounts.data.accounts[0].deleted = true)],
  [
    "unknown system category",
    (d) => {
      const c = addCategory(d, 2, "Unknown system", -1, {
        internal: true,
        groupInternal: true,
      });
      tx(d, "unknown", -1, c.id);
    },
  ],
  [
    "spoofed internal group",
    (d) => {
      const c = addCategory(d, 2, "Inflow: Ready to Assign", 0, {
        internal: true,
      });
      tx(d, "income", 10, c.id);
    },
  ],
  [
    "duplicate system identity",
    (d) => {
      for (const n of [2, 3])
        addCategory(d, n, "Uncategorized", 0, {
          internal: true,
          groupInternal: true,
          groupName: "Internal Master Category",
        });
    },
  ],
  [
    "unknown internal group",
    (d) => {
      const c = addCategory(d, 2, "Unknown", -1, { groupInternal: true });
      tx(d, "unknown", -1, c.id);
    },
  ],
  [
    "ambiguous budget transfer category",
    (d) => {
      d.accounts.data.accounts[1].on_budget = true;
    },
  ],
  [
    "unmapped null category",
    (d) => (d.transactions.data.transactions[0].category_id = null),
  ],
  [
    "integer aggregate overflow",
    (d) => {
      const c = d.month.data.month.categories[0];
      d.transactions.data.transactions = [
        {
          ...d.transactions.data.transactions[0],
          id: "large",
          amount: -Number.MAX_SAFE_INTEGER,
        },
        { ...d.transactions.data.transactions[0], id: "larger", amount: -1 },
      ];
      c.activity = -Number.MAX_SAFE_INTEGER;
      d.month.data.month.activity = c.activity;
    },
  ],
])
  test(`spending refuses ${label} with no fabricated balancing bucket`, async () => {
    const d = docs();
    edit(d);
    await assert.rejects(report(d), code("SPENDING_RECONCILIATION_FAILED"));
  });
test("month snapshot drift fails while order-only differences remain equivalent", async () => {
  await assert.rejects(
    report(undefined, (kind, d, n) => {
      if (kind === "month" && n === 5) d.data.month.income++;
    }),
    code("SPENDING_RECONCILIATION_FAILED"),
  );
  assert.equal(
    (
      await report(undefined, (kind, d, n) => {
        if (kind === "month" && n === 5) d.data.month.categories.reverse();
      })
    ).complete,
    true,
  );
});
test("spending pre-dispatch allowlist, one admission slot, five fixed GETs and no cursor page limit", async () => {
  const seen = [];
  const { c, calls } = client(undefined, (_k, _d, _n, r) => seen.push(r));
  await assert.rejects(
    getSpendingReport(c, { ...args, plan_id: "fixture-plan-usd" }),
    code("PLAN_NOT_ALLOWED"),
  );
  assert.equal(calls(), 0);
  await getSpendingReport(c, args);
  assert.equal(calls(), 5);
  assert.deepEqual(
    seen.map((r) => r.path.split("/").at(-1)),
    [month, "categories", "accounts", "transactions", month],
  );
  assert.deepEqual(seen[3].query, {
    since_date: month,
    until_date: "2026-11-30",
  });
  const d = docs(),
    sample = d.transactions.data.transactions[0];
  d.transactions.data.transactions = Array.from({ length: 250 }, (_, i) => ({
    ...sample,
    id: `dense-${String(i).padStart(3, "0")}`,
    amount: -1,
  }));
  d.month.data.month.categories[0].activity = -250;
  d.month.data.month.activity = -250;
  const r = await report(d);
  assert.equal(r.totals.net_spending_milliunits, 250);
  assert.equal(r.coverage.source_transaction_count, 250);
});
test("five reads share one absolute three-second deadline, abort later reads, and release admission", async () => {
  const budget = new AdmissionBudget();
  let calls = 0;
  const { c } = client(
    undefined,
    async (_k, _d, _n, _r, s) => {
      calls++;
      await new Promise((r) => setTimeout(r, 800));
      if (s.aborted) throw new Error("late");
    },
    budget,
  );
  const start = performance.now();
  await assert.rejects(getSpendingReport(c, args), code("UPSTREAM_TIMEOUT"));
  assert.ok(performance.now() - start < 3800);
  assert.equal(calls, 4);
  const ok = new MockYnabClient(
    parseConfig(fixtureEnv),
    fixtureTransport,
    budget,
  );
  assert.equal(
    (await getSpendingReport(ok, args)).structuredContent.complete,
    true,
  );
});
test("snapshot revocation during reads fails closed before dispatching another read", async () => {
  const mapped = "11111111-1111-4111-8111-111111111111";
  let revoked = false,
    calls = 0;
  const live = {
    lookup: () => ({
      mapped_id: mapped,
      currency_code: "SGD",
      as_of: "2026-11-07T00:00:00Z",
    }),
    check: () => {
      if (revoked)
        throw Object.assign(new Error("revoked"), { code: "PLAN_NOT_ALLOWED" });
    },
  };
  const c = new MockYnabClient(
    parseConfig(fixtureEnv),
    async (r, s) => {
      calls++;
      const out = await fixtureTransport(r, s);
      revoked = true;
      return out;
    },
    undefined,
    live,
  );
  await assert.rejects(getSpendingReport(c, { plan_id: mapped, month }));
  assert.equal(calls, 1);
});
test("cursor retrieves all dense-day rows exactly once and binds source version/window/plan", async () => {
  const d = docs(),
    sample = d.transactions.data.transactions[0];
  d.transactions.data.transactions = Array.from({ length: 250 }, (_, i) => ({
    ...sample,
    id: `dense-${String(i).padStart(3, "0")}`,
    amount: -1,
  }));
  const { c } = client(d);
  const ids = [];
  let cursor;
  do {
    const r = (
      await listTransactions(c, { ...window, ...(cursor ? { cursor } : {}) })
    ).structuredContent;
    ids.push(...r.transactions.map((t) => t.id));
    assert.equal(r.available_count, 250);
    assert.equal(r.truncated, r.next_cursor !== null);
    cursor = r.next_cursor;
  } while (cursor);
  assert.equal(ids.length, 250);
  assert.equal(new Set(ids).size, 250);
  const first = (await listTransactions(c, window)).structuredContent;
  for (const patch of [
    { since_date: "2026-11-02" },
    { until_date: "2026-11-29" },
    { cursor: "not-a-cursor" },
  ])
    await assert.rejects(
      listTransactions(c, { ...window, cursor: first.next_cursor, ...patch }),
      code("STALE_CURSOR"),
    );
  d.transactions.data.server_knowledge++;
  await assert.rejects(
    listTransactions(c, { ...window, cursor: first.next_cursor }),
    code("STALE_CURSOR"),
  );
});
test("monthly raw cap rejects oversized input before report aggregation", async () => {
  const d = docs(),
    sample = d.transactions.data.transactions[0];
  d.transactions.data.transactions = Array.from({ length: 1001 }, (_, i) => ({
    ...sample,
    id: `too-many-${i}`,
  }));
  await assert.rejects(report(d), code("UPSTREAM_RESPONSE_TOO_LARGE"));
});
