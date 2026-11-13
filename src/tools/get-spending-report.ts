import { z } from "zod";
import type { MockYnabClient } from "../ynab/client.js";
import { integer, name, uuid, ordinal } from "../ynab/contracts.js";
import { common, monthInput, success } from "./contracts.js";
import { ToolError } from "./errors.js";

export const inputSchema = monthInput;
const amountFields = {
  gross_outflow_milliunits: integer.nonnegative(),
  category_credit_milliunits: integer.nonnegative(),
  net_spending_milliunits: integer,
  categorized_transfer_net_milliunits: integer,
};
export const outputSchema = z.strictObject({
  ...common,
  truncated: z.literal(false),
  month: z.string(),
  since_date: z.string(),
  until_date: z.string(),
  period_closed: z.boolean(),
  complete: z.literal(true),
  pending_excluded: z.literal(true),
  method: z.literal("reconciled-category-spending-v1"),
  definition: z.literal(
    "Net category outflows less category credits; categorized budget-to-tracking transfers included and separately disclosed. Income and budget-to-budget transfers excluded. Credits are not assumed to be refunds.",
  ),
  totals: z.strictObject(amountFields),
  categories: z
    .array(
      z.strictObject({
        id: uuid,
        name,
        category_group_id: uuid,
        category_group_name: name,
        hidden: z.boolean(),
        ...amountFields,
        activity_milliunits: integer,
        transaction_line_count: integer.nonnegative(),
      }),
    )
    .max(1000),
  reconciliation: z.strictObject({
    status: z.literal("matched"),
    budget_activity_milliunits: integer,
    spending_category_activity_milliunits: integer,
    payment_category_activity_milliunits: integer,
    income_category_activity_milliunits: integer,
    difference_milliunits: z.literal(0),
    transaction_category_difference_milliunits: z.literal(0),
    month_snapshot_stable: z.literal(true),
  }),
  coverage: z.strictObject({
    source_transaction_count: integer.nonnegative(),
    spending_line_count: integer.nonnegative(),
    excluded_income_line_count: integer.nonnegative(),
    excluded_budget_transfer_line_count: integer.nonnegative(),
    excluded_tracking_line_count: integer.nonnegative(),
  }),
});
function fail(): never {
  throw new ToolError("SPENDING_RECONCILIATION_FAILED");
}
function add(a: number, b: number) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail();
  return result;
}
function unique<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) fail();
    map.set(k, item);
  }
  return map;
}
const key = (id: string) => id.toLowerCase();
const empty = () => ({
  gross_outflow_milliunits: 0,
  category_credit_milliunits: 0,
  net_spending_milliunits: 0,
  categorized_transfer_net_milliunits: 0,
});

export async function getSpendingReport(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return client.spending(
    value,
    signal,
    ({ args, before, after, groups, accounts, transactions, until }) => {
      if (
        before.month !== args.month ||
        after.month !== args.month ||
        before.deleted ||
        after.deleted
      )
        fail();
      // Compare consumed financial fields and categories, independent of provider order.
      const snapshot = (m: typeof before) =>
        JSON.stringify({
          ...m,
          categories: [...m.categories].sort((a, b) =>
            ordinal(key(a.id), key(b.id)),
          ),
        });
      if (snapshot(before) !== snapshot(after)) fail();
      const groupMap = unique(groups, (g) => key(g.id));
      const metadata = unique(
        groups.flatMap((g) => g.categories.map((c) => ({ c, g }))),
        (x) => key(x.c.id),
      );
      // System names alone are not enough: require the provider's internal flags
      // and unique system identities, so a user category cannot impersonate one.
      const systemNames = new Set([
        "Inflow: Ready to Assign",
        "Deferred Income SubCategory",
        "Uncategorized",
        "Credit Card Interest",
      ]);
      const systems = new Set<string>();
      const systemGroups = new Set<string>();
      for (const g of groups) {
        if (g.deleted) continue;
        if (
          g.internal &&
          [
            "Internal Master Category",
            "Credit Card Payments",
            "Hidden Categories",
          ].includes(g.name)
        ) {
          if (systemGroups.has(g.name)) fail();
          systemGroups.add(g.name);
        }
        for (const c of g.categories) {
          if (key(c.category_group_id) !== key(g.id)) fail();
          if (!c.deleted && c.internal && systemNames.has(c.name)) {
            if (
              !g.internal ||
              g.name !== "Internal Master Category" ||
              systems.has(c.name)
            )
              fail();
            systems.add(c.name);
          }
        }
      }
      const monthMap = unique(before.categories, (c) => key(c.id));
      const accountMap = unique(accounts, (a) => key(a.id));
      unique(
        transactions.flatMap((t) => [{ id: t.id }, ...t.subtransactions]),
        (t) => t.id,
      );
      const categories: z.infer<typeof outputSchema>["categories"] = [];
      const reportMap = new Map<string, (typeof categories)[number]>();
      const incomeIds = new Set<string>();
      let uncategorized: string | undefined;
      let paymentActivity = 0,
        incomeActivity = 0,
        spendingActivity = 0,
        categoryActivity = 0;
      for (const c of before.categories) {
        if (c.deleted) continue;
        const meta = metadata.get(key(c.id));
        const g = groupMap.get(key(c.category_group_id));
        if (
          !meta ||
          !g ||
          g.deleted ||
          meta.c.deleted ||
          key(meta.g.id) !== key(g.id) ||
          key(meta.c.category_group_id) !== key(g.id) ||
          c.internal !== meta.c.internal ||
          c.name !== meta.c.name
        )
          fail();
        categoryActivity = add(categoryActivity, c.activity);
        if (g.internal && g.name === "Credit Card Payments" && !c.internal) {
          paymentActivity = add(paymentActivity, c.activity);
          continue;
        }
        if (
          c.internal &&
          (c.name === "Inflow: Ready to Assign" ||
            c.name === "Deferred Income SubCategory")
        ) {
          incomeIds.add(key(c.id));
          incomeActivity = add(incomeActivity, c.activity);
          continue;
        }
        if (c.internal && c.name === "Uncategorized") {
          if (uncategorized) fail();
          uncategorized = key(c.id);
        } else if (c.internal && c.name !== "Credit Card Interest") {
          if (c.activity !== 0) fail();
          continue;
        } else if (
          g.internal &&
          g.name !== "Hidden Categories" &&
          !(g.name === "Internal Master Category" && c.internal)
        ) {
          if (c.activity !== 0) fail();
          continue;
        }
        const row = {
          id: c.id,
          name: c.name,
          category_group_id: g.id,
          category_group_name: g.name,
          hidden: c.hidden || g.hidden,
          ...empty(),
          activity_milliunits: c.activity,
          transaction_line_count: 0,
        };
        categories.push(row);
        reportMap.set(key(c.id), row);
        spendingActivity = add(spendingActivity, c.activity);
      }
      // Income IDs can be omitted from the provider's month category array.
      for (const { c, g } of metadata.values()) {
        if (
          !c.deleted &&
          !g.deleted &&
          c.internal &&
          (c.name === "Inflow: Ready to Assign" ||
            c.name === "Deferred Income SubCategory")
        )
          incomeIds.add(key(c.id));
      }
      const coverage = {
        source_transaction_count: 0,
        spending_line_count: 0,
        excluded_income_line_count: 0,
        excluded_budget_transfer_line_count: 0,
        excluded_tracking_line_count: 0,
      };
      for (const t of transactions) {
        if (t.deleted || t.date < args.month || t.date > until) continue;
        coverage.source_transaction_count++;
        const account = accountMap.get(key(t.account_id));
        if (!account || account.deleted) fail();
        const children = t.subtransactions.filter((c) => !c.deleted);
        if (
          t.subtransactions.length &&
          (!children.length ||
            children.some((c) => c.transaction_id !== t.id) ||
            children.reduce((sum, c) => add(sum, c.amount), 0) !== t.amount)
        )
          fail();
        for (const line of t.subtransactions.length ? children : [t]) {
          if (!account.on_budget) {
            coverage.excluded_tracking_line_count++;
            continue;
          }
          const target = line.transfer_account_id
            ? accountMap.get(key(line.transfer_account_id))
            : undefined;
          if (line.transfer_account_id && (!target || target.deleted)) fail();
          if (target?.on_budget) {
            if (line.category_id && line.amount !== 0) fail();
            coverage.excluded_budget_transfer_line_count++;
            continue;
          }
          const categoryId = line.category_id
            ? key(line.category_id)
            : uncategorized;
          if (categoryId && incomeIds.has(categoryId)) {
            coverage.excluded_income_line_count++;
            continue;
          }
          const row = categoryId ? reportMap.get(categoryId) : undefined;
          if (!row || !monthMap.has(key(row.id))) fail();
          row.gross_outflow_milliunits = add(
            row.gross_outflow_milliunits,
            Math.max(-line.amount, 0),
          );
          row.category_credit_milliunits = add(
            row.category_credit_milliunits,
            Math.max(line.amount, 0),
          );
          row.net_spending_milliunits = add(
            row.net_spending_milliunits,
            -line.amount,
          );
          if (target)
            row.categorized_transfer_net_milliunits = add(
              row.categorized_transfer_net_milliunits,
              -line.amount,
            );
          row.transaction_line_count++;
          coverage.spending_line_count++;
        }
      }
      if (
        // YNAB includes Ready to Assign income in the category array, but
        // excludes that income from the month's budget activity total.
        add(categoryActivity, -incomeActivity) !== before.activity ||
        add(spendingActivity, paymentActivity) !== before.activity
      )
        fail();
      const totals = empty();
      for (const row of categories) {
        if (row.net_spending_milliunits !== -row.activity_milliunits) fail();
        for (const field of Object.keys(totals) as (keyof typeof totals)[])
          totals[field] = add(totals[field], row[field]);
      }
      categories.sort((a, b) => ordinal(key(a.id), key(b.id)));
      const context = client.context(args.plan_id);
      return success(outputSchema, {
        ...context,
        truncated: false,
        month: args.month,
        since_date: args.month,
        until_date: until,
        period_closed: until < context.as_of.slice(0, 10),
        complete: true,
        pending_excluded: true,
        method: "reconciled-category-spending-v1",
        definition:
          "Net category outflows less category credits; categorized budget-to-tracking transfers included and separately disclosed. Income and budget-to-budget transfers excluded. Credits are not assumed to be refunds.",
        totals,
        categories,
        reconciliation: {
          status: "matched",
          budget_activity_milliunits: before.activity,
          spending_category_activity_milliunits: spendingActivity,
          payment_category_activity_milliunits: paymentActivity,
          income_category_activity_milliunits: incomeActivity,
          difference_milliunits: 0,
          transaction_category_difference_milliunits: 0,
          month_snapshot_stable: true,
        },
        coverage,
      });
    },
  );
}
