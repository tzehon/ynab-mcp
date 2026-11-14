const plan_id = "fixture-plan-sgd";
const cid = "c0000000-0000-4000-8000-000000000001";
const gid = "c0000000-0000-4000-8000-000000000002";
export const input = {
  plan_id,
  first_month: "2026-08-01",
  last_month: "2026-09-01",
};
const amounts = (gross, credits = 0) => ({
  gross_outflow_milliunits: gross,
  category_credit_milliunits: credits,
  net_spending_milliunits: gross - credits,
  categorized_transfer_net_milliunits: 0,
});
export function report(month, gross, credits = 0) {
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
export const fixture = () => [
  report("2026-08-01", 100000),
  report("2026-09-01", 80000, 30000),
];
