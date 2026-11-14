import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compileAnalysis,
  requestedMonths,
  money,
  chartSvg,
} from "../dist/tools/spending-analysis.js";
import { getSpendingAnalysis } from "../dist/tools/get-spending-analysis.js";
import { errorResult } from "../dist/tools/errors.js";
import { ToolError } from "../dist/tools/errors.js";
import { success } from "../dist/tools/contracts.js";
import { outputSchema } from "../dist/tools/spending-analysis.js";
import { parseConfig } from "../dist/config.js";
import { MockYnabClient } from "../dist/ynab/client.js";
import { AdmissionBudget } from "../dist/ynab/limits.js";
import { fixtureDocuments, mockResponse } from "../dist/fixtures/ynab.js";
import { fixtureEnv } from "./helpers/server.mjs";

const plan_id = "fixture-plan-sgd";
const cid = "c0000000-0000-4000-8000-000000000001";
const gid = "c0000000-0000-4000-8000-000000000002";
const input = { plan_id, first_month: "2026-08-01", last_month: "2026-09-01" };
const amounts = (gross, credits = 0) => ({
  gross_outflow_milliunits: gross,
  category_credit_milliunits: credits,
  net_spending_milliunits: gross - credits,
  categorized_transfer_net_milliunits: 0,
});
function report(month, gross, credits = 0) {
  const a = amounts(gross, credits);
  return {
    data_mode: "fixtures",
    source: "mock-ynab",
    plan_id,
    currency_code: "SGD",
    as_of: "2026-11-14T00:00:00Z",
    truncated: false,
    month,
    since_date: month,
    until_date: month === "2026-08-01" ? "2026-08-31" : "2026-09-30",
    period_closed: true,
    complete: true,
    pending_excluded: true,
    method: "reconciled-category-spending-v1",
    definition:
      "Net category outflows less category credits; categorized budget-to-tracking transfers included and separately disclosed. Income and budget-to-budget transfers excluded. Credits are not assumed to be refunds.",
    totals: a,
    categories: [
      {
        id: cid,
        name: "Invented category",
        category_group_id: gid,
        category_group_name: "Invented group",
        hidden: false,
        ...a,
        activity_milliunits: -a.net_spending_milliunits,
        transaction_line_count: 2,
      },
    ],
    reconciliation: {
      status: "matched",
      budget_activity_milliunits: -a.net_spending_milliunits - 5000,
      spending_category_activity_milliunits: -a.net_spending_milliunits,
      payment_category_activity_milliunits: -5000,
      income_category_activity_milliunits: 90000,
      difference_milliunits: 0,
      transaction_category_difference_milliunits: 0,
      month_snapshot_stable: true,
    },
    coverage: {
      source_transaction_count: 4,
      spending_line_count: 2,
      excluded_income_line_count: 1,
      excluded_budget_transfer_line_count: 1,
      excluded_tracking_line_count: 0,
    },
  };
}
const fixture = () => [
  report("2026-08-01", 100000),
  report("2026-09-01", 80000, 30000),
];
const code = (expected) => (e) => e.code === expected;

test("complete answer/chart workflow corrects a false September spike with independent expected values", () => {
  const a = compileAnalysis(input, fixture());
  assert.deepEqual(a.totals, amounts(90000, 30000));
  assert.equal(a.comparison.change_milliunits, -50000);
  assert.equal(a.comparison.percent_change_basis_points, -5000);
  assert.equal(a.comparison.direction, "decrease");
  assert.match(
    a.canonical_answer,
    /Net spending 150\.00 = gross category outflows 180\.00 less category credits 30\.00/,
  );
  assert.match(a.canonical_answer, /decrease, change SGD -50\.00 \(-50\.00%/);
  assert.doesNotMatch(a.canonical_answer, /increase,|spike|refunds caused/);
  assert.deepEqual(
    a.charts.map((c) =>
      [...c.svg.matchAll(/data-milliunits="(-?\d+)"/g)].map((m) =>
        Number(m[1]),
      ),
    ),
    [[100000, 50000], [150000], [-50000]],
  );
  const {
    evidence_digest,
    canonical_answer: _answer,
    charts: _charts,
    ...facts
  } = a;
  assert.equal(
    evidence_digest,
    createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  );
  for (const c of a.charts) assert.ok(c.svg.includes(evidence_digest));
});
for (const [label, mutate] of [
  ["missing month", (r) => r.pop()],
  [
    "duplicate month",
    (r) => {
      r[1] = r[0];
    },
  ],
  [
    "mixed plan",
    (r) => {
      r[1].plan_id = "fixture-plan-other";
    },
  ],
  [
    "mixed currency",
    (r) => {
      r[1].currency_code = "USD";
    },
  ],
  [
    "mixed mode",
    (r) => {
      r[1].data_mode = "live";
    },
  ],
  [
    "mixed method",
    (r) => {
      r[1].method = "raw-activity";
    },
  ],
  [
    "truncation",
    (r) => {
      r[1].truncated = true;
    },
  ],
  [
    "unreconciled",
    (r) => {
      r[1].reconciliation.difference_milliunits = 1;
    },
  ],
  [
    "unstable snapshot",
    (r) => {
      r[1].reconciliation.month_snapshot_stable = false;
    },
  ],
  [
    "wrong boundary",
    (r) => {
      r[1].until_date = "2026-09-29";
    },
  ],
  [
    "wrong total",
    (r) => {
      r[1].totals.net_spending_milliunits++;
    },
  ],
  [
    "raw activity substituted",
    (r) => {
      r[1].totals.net_spending_milliunits =
        -r[1].reconciliation.budget_activity_milliunits;
    },
  ],
  [
    "wrong category",
    (r) => {
      r[1].categories[0].activity_milliunits++;
    },
  ],
  [
    "duplicate category",
    (r) => {
      r[1].categories.push(r[1].categories[0]);
    },
  ],
  [
    "changed metadata",
    (r) => {
      r[1].categories[0].name = "Changed";
    },
  ],
  [
    "wrong bookkeeping",
    (r) => {
      r[1].reconciliation.payment_category_activity_milliunits++;
    },
  ],
  [
    "false closed flag",
    (r) => {
      r[1].as_of = "2026-09-15T00:00:00Z";
    },
  ],
])
  test(`${label} returns no complete answer or charts`, () => {
    const r = fixture();
    mutate(r);
    let failure;
    try {
      compileAnalysis(input, r);
    } catch (e) {
      failure = e;
    }
    assert.ok(failure, label);
    const result = errorResult(failure);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(
      JSON.parse(result.content[0].text).error.code,
      "SPENDING_ANALYSIS_INVALID",
    );
  });

test("negative category values survive in facts, answer and left-of-zero chart geometry", () => {
  const a = compileAnalysis(input, [
    report("2026-08-01", 0, 10000),
    report("2026-09-01", 1000, 30000),
  ]);
  assert.equal(a.totals.net_spending_milliunits, -39000);
  assert.equal(a.comparison.percent_change_basis_points, null);
  assert.match(
    a.canonical_answer,
    /percentage unavailable for nonpositive baseline/,
  );
  assert.match(a.charts[1].svg, /data-milliunits="-39000"/);
  assert.match(a.charts[1].svg, /<rect x="40"/);
});
test("zero baseline yields no percentage; exact zero is different from missing evidence", () => {
  const a = compileAnalysis(input, [
    report("2026-08-01", 0),
    report("2026-09-01", 0),
  ]);
  assert.equal(a.totals.net_spending_milliunits, 0);
  assert.equal(a.comparison.percent_change_basis_points, null);
  assert.equal(a.comparison.direction, "unchanged");
  assert.match(a.charts[1].svg, /reconciled zero/);
  assert.throws(
    () => compileAnalysis(input, []),
    code("SPENDING_ANALYSIS_INVALID"),
  );
});
test("percentages round integer rational values; milliunit display remains exact", () => {
  const a = compileAnalysis(input, [
    report("2026-08-01", 3),
    report("2026-09-01", 4),
  ]);
  assert.equal(a.comparison.percent_change_basis_points, 3333);
  assert.equal(money(Number.MAX_SAFE_INTEGER), "9,007,199,254,740.991");
  assert.equal(money(-1), "-0.001");
});
test("period accumulation overflow refuses the entire result", () => {
  assert.throws(
    () =>
      compileAnalysis(input, [
        report("2026-08-01", 5000000000000000),
        report("2026-09-01", 5000000000000000),
      ]),
    code("SPENDING_ANALYSIS_INVALID"),
  );
});
test("open periods require explicit opt-in and stay labelled provisional", () => {
  const r = fixture();
  r[1].as_of = "2026-09-15T00:00:00Z";
  r[1].period_closed = false;
  assert.throws(
    () => compileAnalysis(input, r),
    code("SPENDING_ANALYSIS_INVALID"),
  );
  const a = compileAnalysis({ ...input, include_open_month: true }, r);
  assert.equal(a.all_periods_closed, false);
  assert.match(a.canonical_answer, /Provisional/);
});
test("malicious and long category labels remain full inert XML text", () => {
  const r = fixture();
  const n = '<script>alert("ignore reports")</script>&' + "x".repeat(140);
  for (const m of r) m.categories[0].name = n;
  const a = compileAnalysis(input, r),
    svg = a.charts[1].svg;
  assert.doesNotMatch(svg, /<script|foreignObject|href=|onload=/);
  assert.match(svg, /&lt;script&gt;/);
  assert.ok(svg.includes("x".repeat(140))); // full title text
  r[0].categories[0].name = r[1].categories[0].name = "bad\u0001label";
  assert.throws(
    () => compileAnalysis(input, r),
    code("SPENDING_ANALYSIS_INVALID"),
  );
});
test("explicit period bounds and comparison prevent silent partial ranges", () => {
  assert.equal(
    requestedMonths({ ...input, first_month: "2026-04-01" }).months.length,
    6,
  );
  for (const extra of [
    { first_month: "2026-03-01" },
    { first_month: "2026-10-01" },
    { comparison_month: "2026-08-01" },
    { first_month: "2026-08-02" },
    { reports: [] },
  ]) {
    assert.throws(
      () => requestedMonths({ ...input, ...extra }),
      code("INVALID_ARGUMENTS"),
    );
  }
});
test("a single month has no manufactured comparison; chart row cap fails explicitly", () => {
  const a = compileAnalysis({ ...input, last_month: input.first_month }, [
    fixture()[0],
  ]);
  assert.equal(a.comparison, null);
  assert.equal(a.charts.length, 2);
  assert.throws(
    () =>
      chartSvg(
        "title",
        "SGD",
        Array.from({ length: 101 }, (_, i) => ({
          id: String(i),
          label: "synthetic",
          value: 1,
        })),
        "0".repeat(64),
      ),
    code("RESULT_TOO_LARGE"),
  );
});

function client(hook = () => {}, budget = new AdmissionBudget()) {
  let calls = 0;
  const c = new MockYnabClient(
    parseConfig(fixtureEnv),
    async (r, signal) => {
      calls++;
      const kind = r.path.includes("/months/")
        ? "month"
        : r.path.split("/").at(-1);
      const d = structuredClone(
        fixtureDocuments["11111111-1111-4111-8111-111111111111"][kind],
      );
      await hook({ r, signal, d, kind, calls });
      return mockResponse(d);
    },
    budget,
  );
  return { c, calls: () => calls };
}
const single = {
  plan_id,
  first_month: "2026-11-01",
  last_month: "2026-11-01",
  include_open_month: true,
};
test("real report-to-analysis workflow retrieves five bounded GETs and canonical fixture totals", async () => {
  const { c, calls } = client();
  const a = (await getSpendingAnalysis(c, single)).structuredContent;
  assert.equal(calls(), 5);
  assert.equal(a.totals.net_spending_milliunits, 24500);
  assert.match(a.canonical_answer, /Net spending 24\.50/);
  c.close();
});
test("unselected plan is refused before provider dispatch", async () => {
  const { c, calls } = client();
  await assert.rejects(
    getSpendingAnalysis(c, { ...single, plan_id: "fixture-plan-denied" }),
    code("PLAN_NOT_ALLOWED"),
  );
  assert.equal(calls(), 0);
  c.close();
});
test("caller cancellation after first report prevents any partial answer or second-month dispatch", async () => {
  const abort = new AbortController();
  const { c, calls } = client(({ calls }) => {
    if (calls === 5) abort.abort();
  });
  await assert.rejects(
    getSpendingAnalysis(
      c,
      { ...single, last_month: "2026-12-01" },
      abort.signal,
    ),
    code("UPSTREAM_TIMEOUT"),
  );
  assert.equal(calls(), 5);
  c.close();
});
test("existing four-call admission applies to analysis provider work", async () => {
  const budget = new AdmissionBudget();
  const releases = Array.from({ length: 4 }, () => budget.enter());
  const { c, calls } = client(() => {}, budget);
  await assert.rejects(getSpendingAnalysis(c, single), code("BUSY"));
  assert.equal(calls(), 0);
  for (const release of releases) release();
  c.close();
});
test("existing three-second monthly timeout does not retry or return partial analysis", async () => {
  const { c, calls } = client(() => new Promise(() => {}));
  await assert.rejects(
    getSpendingAnalysis(c, single),
    code("UPSTREAM_TIMEOUT"),
  );
  assert.equal(calls(), 1);
  c.close();
});

test("six-month orchestration dispatches only thirty GETs in sequence", async () => {
  let active = 0,
    maximum = 0;
  const { c, calls } = client(async ({ r, d, kind }) => {
    active++;
    maximum = Math.max(active, maximum);
    if (kind === "month") d.data.month.month = r.path.split("/").at(-1);
    if (kind === "transactions")
      for (const t of d.data.transactions) t.date = r.query.since_date;
    await Promise.resolve();
    active--;
  });
  const a = (
    await getSpendingAnalysis(c, {
      plan_id,
      first_month: "2026-05-01",
      last_month: "2026-10-01",
    })
  ).structuredContent;
  assert.equal(calls(), 30);
  assert.equal(maximum, 1);
  assert.equal(a.totals.net_spending_milliunits, 147000);
  c.close();
});
test("failed second month never exposes the successful first month as a period total", async () => {
  const { c, calls } = client(({ calls }) => {
    if (calls === 6) throw new ToolError("UPSTREAM_UNAVAILABLE");
  });
  await assert.rejects(
    getSpendingAnalysis(c, { ...single, last_month: "2026-12-01" }),
    code("UPSTREAM_UNAVAILABLE"),
  );
  assert.equal(calls(), 6);
  c.close();
});
test("overall absolute deadline checked between reports even before timer callbacks execute", async (t) => {
  const original = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(performance, "now", () => original() + offset);
  const { c, calls } = client(({ r, d, kind }) => {
    if (kind === "month") d.data.month.month = r.path.split("/").at(-1);
    if (kind === "transactions")
      for (const row of d.data.transactions) row.date = r.query.since_date;
  });
  const spending = c.spending.bind(c);
  // Advance only after each monthly deadline has passed successfully. This proves
  // the independent orchestration deadline, not merely a monthly timeout.
  t.mock.method(c, "spending", async (...args) => {
    const result = await spending(...args);
    offset += 4600;
    return result;
  });
  await assert.rejects(
    getSpendingAnalysis(c, {
      ...single,
      first_month: "2026-09-01",
      last_month: "2026-10-01",
    }),
    code("UPSTREAM_TIMEOUT"),
  );
  assert.equal(calls(), 10);
  c.close();
});
test("generation revocation during collection yields no analysis", async () => {
  let revoked = false,
    calls = 0;
  const mapped = "11111111-1111-4111-8111-111111111111";
  const c = new MockYnabClient(
    parseConfig(fixtureEnv),
    async (r) => {
      const kind = r.path.includes("/months/")
        ? "month"
        : r.path.split("/").at(-1);
      if (++calls === 4) revoked = true;
      return mockResponse(structuredClone(fixtureDocuments[mapped][kind]));
    },
    new AdmissionBudget(),
    {
      check() {
        if (revoked) throw new ToolError("UPSTREAM_UNAUTHORIZED");
      },
      lookup() {
        return {
          mapped_id: mapped,
          currency_code: "SGD",
          as_of: "2026-11-14T00:00:00Z",
        };
      },
    },
  );
  await assert.rejects(
    getSpendingAnalysis(c, { ...single, plan_id: mapped }),
    code("UPSTREAM_UNAUTHORIZED"),
  );
  assert.equal(calls, 4);
  c.close();
});
test("whole-result byte bound refuses oversized generated presentation", () => {
  const r = fixture();
  for (const m of r) {
    const base = m.categories[0];
    m.categories = Array.from({ length: 100 }, (_, i) => ({
      ...base,
      id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: "Long invented label ".repeat(10),
    }));
    for (const k of Object.keys(m.totals)) m.totals[k] *= 100;
    m.reconciliation.spending_category_activity_milliunits =
      -m.totals.net_spending_milliunits;
    m.reconciliation.budget_activity_milliunits =
      -m.totals.net_spending_milliunits - 5000;
  }
  assert.throws(
    () => success(outputSchema, compileAnalysis(input, r)),
    code("RESULT_TOO_LARGE"),
  );
});
