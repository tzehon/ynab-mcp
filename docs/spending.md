# Spending reports and evidence

For spending answers, period comparisons and charts, use the
[validated analysis path](spending-analysis.md). The monthly report below is its
source primitive and remains available for explicit reconciliation inspection.

Call `ynab_get_spending_report` with an allowed `plan_id` and month start such as
`2026-11-01`. For six months, make six calls. A successful report provides exact
integer milliunits, currency, retrieval time, period boundaries and coverage.
Divide milliunits by 1,000 only for display; keep arithmetic in integers.

Net spending equals gross category outflows minus category credits. Credits are
not automatically refunds: a refund explanation needs supporting transaction
information. Split children count once and must sum to their parent. Closed
budget accounts and hidden categories remain included. Deleted transactions and
tracking-account sides are excluded. Uncleared posted transactions are included;
pending transactions are outside YNAB's posted-transaction endpoint.

Income and budget-to-budget transfers are excluded. Categorized budget-to-tracking
transfers contribute to YNAB category activity, so they remain in net spending and
are disclosed separately as `categorized_transfer_net_milliunits`. These can be
asset movements rather than purchases; do not describe all net spending as
consumption. Credit-card payment category activity is bookkeeping, shown separately
in reconciliation. Recognized internal categories require provider internal flags
and system-group membership; ordinary categories with similar names stay ordinary.

A report succeeds only when every spending category's transaction sum matches the
provider month category activity exactly, spending-category activity plus card-payment bookkeeping matches raw month
activity (recognized income in the source category array is excluded), and the month snapshot is stable before and after the reads. Duplicate
IDs, missing metadata, inconsistent splits, unknown active system categories,
integer overflow and mismatches fail with a fixed error. There is no adjustment
bucket or fallback to raw month activity. This is cross-endpoint reconciliation,
not a claim that the upstream API provides atomic database snapshots.

The report fetches month, categories, accounts, transactions and month again under
one process admission slot and one three-second deadline, including refresh.
Provider responses retain existing limits: 1 MiB, 1,000 transactions, 1,000
categories, 100 splits per parent / 2,000 total. No retry, persistent financial
cache or new endpoint is introduced. A failure means unavailable evidence; never
substitute zero or silently drop that month from a requested period.

`complete` means the returned bounded posted data reconciled for the stated range.
`period_closed: false` identifies a current/future calendar period, whose amounts
can still change. Historical periods can also be edited in YNAB. Avoid claiming
completeness beyond the upstream source and the reconciliation checks performed.

For drill-down, follow `ynab_list_transactions.next_cursor` in the exact same
window (1–90 inclusive days). Each page is capped at 100, the cursor binds plan,
window, source version and last row, and stale windows must restart. Cursors are
consistency markers, not authorization credentials. Plan allowlisting and grant
checks run independently for every page. Dense days can now be paged without
omitting transactions. The report itself never aggregates truncated display pages.

Before presenting a chart, require successful reconciled reports for every
requested month, confirm one plan/currency/method, and check category sums and
period totals with integer arithmetic. Label gross outflows, credits and net
spending distinctly. Explain spikes using category deltas and the actual underlying
transactions; separate observed amounts from any inferred purpose. Preserve credits
as negative spending rather than clipping them to zero.

Regression fixtures are invented. Release acceptance separately compares actual
owner data across month/category/transaction sources and the actual Codex and
ChatGPT clients. Keep those contents private; publish only pass/fail evidence,
reviewed/deployed revisions and outstanding limitations.
