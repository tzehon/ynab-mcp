import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { Plan } from "./plans.js";
import { uuid } from "../ynab/contracts.js";
import {
  ORIGIN,
  type MockTransport,
  type MockResponse,
} from "../ynab/transport.js";
export const mapEntry = z.strictObject({
  mapped_id: uuid,
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  as_of: z.iso.datetime(),
});
export type FixtureMap = Readonly<
  Record<string, Readonly<z.infer<typeof mapEntry>>>
>;
export const fixtureMap: FixtureMap = Object.freeze({
  "fixture-plan-sgd": Object.freeze({
    mapped_id: "11111111-1111-4111-8111-111111111111",
    currency_code: "SGD",
    as_of: "2026-11-07T00:00:00Z",
  }),
  "fixture-plan-usd": Object.freeze({
    mapped_id: "22222222-2222-4222-8222-222222222222",
    currency_code: "USD",
    as_of: "2026-11-07T00:00:00Z",
  }),
});
export function validateFixtureMap(
  catalog: readonly Plan[],
  value: unknown,
): FixtureMap {
  const parsed = z.record(z.string(), mapEntry).safeParse(value);
  if (!parsed.success) throw new ConfigError("FIXTURE_MAP");
  const map = parsed.data;
  if (
    Object.keys(map).length !== catalog.length ||
    catalog.some((p) => map[p.id]?.currency_code !== p.currency_code) ||
    new Set(Object.values(map).map((p) => p.mapped_id.toLowerCase())).size !==
      catalog.length
  )
    throw new ConfigError("FIXTURE_MAP");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(map).map(([key, v]) => [key, Object.freeze(v)]),
    ),
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
function documents(prefix: string, factor: number) {
  const accountId = `${prefix}0000000-0000-4000-8000-000000000001`;
  const groupId = `${prefix}0000000-0000-4000-8000-000000000002`;
  const categoryId = `${prefix}0000000-0000-4000-8000-000000000003`;
  const otherAccount = `${prefix}0000000-0000-4000-8000-000000000004`;
  const category = {
    id: categoryId,
    category_group_id: groupId,
    name: "Invented essentials",
    hidden: false,
    internal: false,
    deleted: false,
    budgeted: 500000,
    activity: -24500 * factor,
    balance: 500000 - 24500 * factor,
  };
  const base = {
    date: "2026-11-03",
    amount: -12500 * factor,
    account_id: accountId,
    account_name: "Invented checking",
    approved: true,
    cleared: "cleared",
    deleted: false,
    subtransactions: [],
    category_id: categoryId,
    category_name: "Invented essentials",
    payee_name: "Invented shop",
    memo: null,
  };
  return freeze({
    accounts: {
      data: {
        server_knowledge: 1,
        accounts: [
          {
            id: accountId,
            name: "Invented checking",
            type: "checking",
            on_budget: true,
            closed: false,
            balance: 1200000 * factor,
            cleared_balance: 1000000 * factor,
            uncleared_balance: 200000 * factor,
            transfer_payee_id: null,
            deleted: false,
          },
          {
            id: otherAccount,
            name: "Invented closed savings",
            type: "savings",
            on_budget: false,
            closed: true,
            balance: 0,
            cleared_balance: 0,
            uncleared_balance: 0,
            transfer_payee_id: null,
            deleted: false,
          },
        ],
      },
    },
    month: {
      data: {
        month: {
          month: "2026-11-01",
          income: 3000000 * factor,
          budgeted: 2500000 * factor,
          activity: -24500 * factor,
          to_be_budgeted: 500000 * factor,
          deleted: false,
          categories: [category],
        },
      },
    },
    categories: {
      data: {
        server_knowledge: 1,
        category_groups: [
          {
            id: groupId,
            name: "Invented living",
            hidden: false,
            internal: false,
            deleted: false,
            categories: [category],
          },
        ],
      },
    },
    transactions: {
      data: {
        server_knowledge: 1,
        transactions: [
          { ...base, id: `${prefix}-purchase` },
          {
            ...base,
            id: `${prefix}-split`,
            amount: -3000 * factor,
            category_id: null,
            category_name: "Split",
            subtransactions: [
              {
                id: `${prefix}-child-a`,
                transaction_id: `${prefix}-split`,
                amount: -1000 * factor,
                deleted: false,
                category_id: categoryId,
              },
              {
                id: `${prefix}-child-b`,
                transaction_id: `${prefix}-split`,
                amount: -2000 * factor,
                deleted: false,
                category_id: categoryId,
              },
            ],
          },
          {
            ...base,
            id: `${prefix}-transfer`,
            amount: -9000 * factor,
            transfer_account_id: otherAccount,
            transfer_transaction_id: `${prefix}-transfer-other`,
          },
          {
            ...base,
            id: `${prefix}-transfer-other`,
            account_id: otherAccount,
            amount: 9000 * factor,
            transfer_account_id: accountId,
            transfer_transaction_id: `${prefix}-transfer`,
          },
          { ...base, id: `${prefix}-deleted`, deleted: true },
        ],
      },
    },
  });
}
export const fixtureDocuments = freeze({
  "11111111-1111-4111-8111-111111111111": documents("a", 1),
  "22222222-2222-4222-8222-222222222222": documents("b", 2),
});
export function mockResponse(value: unknown, status = 200): MockResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: { "content-type": "application/json" },
    body: (async function* () {
      for (let i = 0; i < bytes.length; i += 8192)
        yield bytes.slice(i, i + 8192);
    })(),
  };
}
export const fixtureTransport: MockTransport = async (request, signal) => {
  if (signal.aborted) throw new Error("CANCELLED");
  if (request.method !== "GET" || request.origin !== ORIGIN)
    return mockResponse({}, 400);
  const match =
    /^\/v1\/plans\/([^/]+)\/(accounts|categories|transactions|months\/2026-11-01)$/.exec(
      request.path,
    );
  if (!match) return mockResponse({}, 404);
  const doc = fixtureDocuments[match[1] as keyof typeof fixtureDocuments];
  if (!doc) return mockResponse({}, 404);
  const route = match[2];
  if (route === "transactions") {
    if (Object.keys(request.query).sort().join() !== "since_date,until_date")
      return mockResponse({}, 400);
    return mockResponse({
      data: {
        server_knowledge: 1,
        transactions: doc.transactions.data.transactions.filter(
          (t) =>
            t.date >= (request.query.since_date ?? "") &&
            t.date <= (request.query.until_date ?? ""),
        ),
      },
    });
  }
  if (Object.keys(request.query).length) return mockResponse({}, 400);
  return mockResponse(
    route === "accounts"
      ? doc.accounts
      : route === "categories"
        ? doc.categories
        : doc.month,
  );
};
