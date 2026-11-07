import test from "node:test";
import assert from "node:assert/strict";
import { MockYnabClient } from "../dist/ynab/client.js";
import { AdmissionBudget } from "../dist/ynab/limits.js";
import { parseConfig } from "../dist/config.js";
import {
  fixtureTransport,
  fixtureDocuments,
  mockResponse,
} from "../dist/fixtures/ynab.js";
import { listAccounts } from "../dist/tools/list-accounts.js";
import { getMonth } from "../dist/tools/get-month.js";
import { listCategories } from "../dist/tools/list-categories.js";
import { listTransactions } from "../dist/tools/list-transactions.js";
import { fixtureEnv, serve, connect } from "./helpers/server.mjs";
const plan_id = "fixture-plan-sgd",
  args = { plan_id, since_date: "2026-11-01", until_date: "2026-11-07" };
const document = () =>
  structuredClone(
    fixtureDocuments["11111111-1111-4111-8111-111111111111"].transactions,
  );
const client = (transport, env = {}) =>
  new MockYnabClient(
    parseConfig({ ...fixtureEnv, ...env }),
    transport,
    new AdmissionBudget(),
  );
const cases = [
  [listAccounts, { plan_id }],
  [getMonth, { plan_id, month: "2026-11-01" }],
  [listCategories, { plan_id }],
  [listTransactions, args],
];
const code = (c) => (e) => e.code === c;
test("every new tool rejects malformed arguments and all override classes before dispatch", async () => {
  let calls = 0;
  const c = client(async (...a) => {
    calls++;
    return fixtureTransport(...a);
  });
  for (const [tool, valid] of cases) {
    for (const input of [
      undefined,
      null,
      [],
      7,
      "text",
      {},
      ...[
        "url",
        "method",
        "credential",
        "path",
        "cursor",
        "limit_override",
      ].map((k) => ({ ...valid, [k]: "SECRET_MARKER" })),
      ...["default", "last-used", "11111111-1111-4111-8111-111111111111"].map(
        (id) => ({ ...valid, plan_id: id }),
      ),
    ])
      await assert.rejects(tool(c, input), code("INVALID_ARGUMENTS"));
    for (const missing of [undefined, "[]"])
      await assert.rejects(
        tool(
          client(
            async () => {
              calls++;
            },
            { FIXTURE_ALLOWED_PLAN_IDS: missing },
          ),
          valid,
        ),
        code("PLAN_NOT_ALLOWED"),
      );
  }
  assert.equal(calls, 0);
});
test("transaction boundary counts, deletion nesting, date sort and child transfers retain exact values", async () => {
  for (const count of [1, 2, 3]) {
    const d = document(),
      base = d.data.transactions[0];
    d.data.transactions = Array.from({ length: count }, (_, i) => ({
      ...base,
      id: `row-${i}`,
      date: i === 0 ? "2026-11-01" : "2026-11-07",
      amount:
        i === 0
          ? 0
          : i === 1
            ? Number.MAX_SAFE_INTEGER
            : Number.MIN_SAFE_INTEGER,
    }));
    const r = (
      await listTransactions(
        client(async () => mockResponse(d)),
        { ...args, limit: 2 },
      )
    ).structuredContent;
    assert.equal(r.available_count, count);
    assert.equal(r.returned_count, Math.min(2, count));
    assert.equal(r.truncated, count > 2);
    assert.deepEqual(
      r.transactions.map((t) => t.id),
      count === 1
        ? ["row-0"]
        : count === 2
          ? ["row-1", "row-0"]
          : ["row-1", "row-2"],
    );
    assert.equal(
      r.transactions[0].amount_milliunits,
      count === 1 ? 0 : Number.MAX_SAFE_INTEGER,
    );
    assert.deepEqual(
      Object.keys(r).sort(),
      [
        "data_mode",
        "source",
        "plan_id",
        "currency_code",
        "as_of",
        "truncated",
        "since_date",
        "until_date",
        "limit",
        "returned_count",
        "available_count",
        "pending_excluded",
        "transactions",
      ].sort(),
    );
  }
  const d = document();
  const split = d.data.transactions[1];
  split.subtransactions[0].transfer_account_id =
    "a0000000-0000-4000-8000-000000000004";
  split.subtransactions[0].transfer_transaction_id = "missing-other-leg";
  d.data.transactions = [
    split,
    {
      ...structuredClone(split),
      id: "deleted-parent",
      deleted: true,
      subtransactions: split.subtransactions.map((s, i) => ({
        ...s,
        id: `deleted-child-${i}`,
        transaction_id: "deleted-parent",
      })),
    },
  ];
  const r = (
    await listTransactions(
      client(async () => mockResponse(d)),
      args,
    )
  ).structuredContent;
  assert.equal(r.transactions.length, 1);
  assert.equal(
    r.transactions[0].subtransactions[0].transfer_transaction_id,
    "missing-other-leg",
  );
  assert.equal(r.transactions[0].amount_milliunits, -3000);
  assert.equal(r.transactions[0].subtransactions.length, 2);
  for (const value of [Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = document();
    bad.data.transactions[0].amount = value;
    await assert.rejects(
      listTransactions(
        client(async () => mockResponse(bad)),
        args,
      ),
      code("UPSTREAM_INVALID_RESPONSE"),
    );
  }
});
test("actual normalized transaction result accepts exact 65536 UTF-8 bytes and rejects 65537", async () => {
  const d = document(),
    base = d.data.transactions[0];
  d.data.transactions = Array.from({ length: 100 }, (_, i) => ({
    ...base,
    id: `boundary-${String(i).padStart(3, "0")}`,
    memo: "",
  }));
  const run = () =>
    listTransactions(
      client(async () => mockResponse(d)),
      { ...args, limit: 100 },
    );
  let padding = 65536 - Buffer.byteLength((await run()).content[0].text);
  assert.ok(padding > 0 && padding < 49900);
  for (const row of d.data.transactions) {
    const n = Math.min(499, padding);
    row.memo = "x".repeat(n);
    padding -= n;
  }
  assert.equal(padding, 0);
  const r = await run();
  assert.equal(Buffer.byteLength(JSON.stringify(r.structuredContent)), 65536);
  d.data.transactions.at(-1).memo += "x";
  await assert.rejects(run(), code("RESULT_TOO_LARGE"));
});
for (const era of ["legacy", "modern"])
  test(`HTTP ${era} rejects malformed tool inputs without dispatch and redacts all status details`, async (t) => {
    let calls = 0,
      status = 401;
    const app = await serve(t, {}, undefined, async () => {
      calls++;
      return mockResponse({ error: "SECRET_BODY" }, status);
    });
    const c = await connect(t, app.url, era);
    for (const name of [
      "ynab_list_accounts",
      "ynab_get_month",
      "ynab_list_categories",
      "ynab_list_transactions",
    ]) {
      for (const value of [{}, { plan_id, url: "SECRET_URL" }, null]) {
        let r;
        try {
          r = await c.callTool({ name, arguments: value });
        } catch (e) {
          assert.ok(!e.message.includes("SECRET"));
          continue;
        }
        assert.equal(r.isError, true);
        assert.equal(r.structuredContent, undefined);
        assert.ok(!JSON.stringify(r).includes("SECRET"));
      }
    }
    assert.equal(calls, 0);
    for (const [s, expected] of [
      [401, "UPSTREAM_UNAUTHORIZED"],
      [403, "UPSTREAM_FORBIDDEN"],
      [404, "NOT_FOUND"],
      [429, "UPSTREAM_RATE_LIMITED"],
      [503, "UPSTREAM_UNAVAILABLE"],
      [302, "UPSTREAM_FAILURE"],
      [400, "UPSTREAM_FAILURE"],
      [200, "UPSTREAM_INVALID_RESPONSE"],
    ]) {
      status = s;
      const r = await c.callTool({
        name: "ynab_list_accounts",
        arguments: { plan_id },
      });
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent, undefined);
      assert.equal(JSON.parse(r.content[0].text).error.code, expected);
      assert.ok(!JSON.stringify(r).includes("SECRET"));
    }
    assert.equal(calls, 8);
  });
