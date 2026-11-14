# Validated spending answers and charts

For spending questions use `ynab_get_spending_analysis`, with the selected
`plan_id`, explicit `first_month` and `last_month` (`YYYY-MM-01`). It accepts one
through six consecutive months. For a specific comparison, `comparison_month`
compares that month with its immediately preceding month inside the range.
Otherwise the final pair is compared; one month has no comparison.

Resolve “last six months” to six complete calendar months using the user's current
date. For example, on 14 November 2026 use May through October 2026. A request
explicitly including the current month requires `include_open_month: true` and
the returned provisional label. Do not silently change an unsupported range.

## What is enforced

The server obtains reconciled monthly reports itself. It accepts no client-authored
reports, amounts or chart input. It validates every requested month, period,
plan/currency/source/method, reconciliation and category arithmetic before
computing any period totals. Failure returns a fixed error without partial facts,
answers or charts. A missing month is unknown, never zero.

`totals`, `months`, `categories` and `comparison` contain integer milliunits.
Gross outflows minus category credits equals net spending. All category comparison
changes sum to the month change. Income/card-payment bookkeeping are excluded;
categorized tracking transfers are included and separately disclosed. A credit
does not by itself prove a refund, reimbursement or purchase purpose.

Percentage change is computed only for a positive previous-month net amount;
otherwise it is null. `percent_change_basis_points` is percentage points times
100 (1234 means 12.34%), rounded to nearest basis point, ties away from zero,
using integer rational arithmetic. Financial values retain milliunit precision;
presentation conversion never changes underlying amounts.

`canonical_answer` is generated in code from these facts. `charts` contains
self-contained inert SVGs for monthly net spending, period category net spending
and category comparison deltas. These use the same exact values, preserve negative
bars and full category labels, and include currency, range, retrieval time and
provisional status. Category rows with zero gross, credits and transfer/net
activity across the entire period are omitted with an explicit count. Comparison
rows omit only zero changes; no residual or balancing bucket is invented.

`evidence_digest` identifies the serialized facts used for the answer/charts. It
is correspondence metadata, not a signature, authorization token or proof of an
atomic provider snapshot. Monthly reports reconcile their individual reads;
cross-month edits and future changes remain possible. Changed category metadata
across the collected months is rejected rather than guessed.

## Client presentation contract

1. Call analysis for spending totals, category breakdowns and charts. Use raw month
   activity only for an explicit accounting question, never as a spending substitute.
2. On success, use the returned canonical answer and exact facts. Prefer the
   client's native visualization or artifact capability when available: for example
   Codex Visualize or Claude artifacts. Bind monthly rows to `months`, category rows
   to `categories` and comparison rows to `comparison.category_changes`; use the
   returned totals, direction and percentage rather than recomputing them. Layout,
   sorting and unit formatting are presentation, not permission to change facts.
   Preserve integer milliunits before formatting, every requested row, full labels,
   date/currency/gross-credit-net/provisional notices, `as_of` and `evidence_digest`.
   Do not infer a spike from the prompt or clip negative categories. The generated
   SVGs and authenticated MCP App remain supported fallbacks.
3. Explain observed changes with `comparison.category_changes`. A claimed spike
   must be corrected when `direction` is decrease or unchanged. Transaction cursor
   pages support further investigation; distinguish observed amounts from inferred
   causes and require actual evidence for any transaction-purpose explanation.
4. On error, say the analysis is unavailable and identify the error. Do not fall
   back to raw activity, partial pages, invented charts or zeros. If neither native
   visualization nor the supplied view/SVG is supported, provide the canonical
   answer and explain that display limitation. Refresh discovery/start a fresh chat
   after guidance updates or if the seventh tool is absent.

MCP instructions guide a general-purpose assistant; they cannot force every
external client's prose to comply. The deterministic tool outputs are enforced.
Release qualification must inspect actual tool selection and presented financial
claims instead of treating a model's self-reported success as sufficient.

## Bounds and verification

At most six sequential reports/30 fixed provider GETs share an nine-second overall
cancellation deadline. Each existing monthly report retains its three-second
deadline and four-call process admission, raw and output caps. There are no
parallel provider calls, retries, persistent financial caches, new scopes or routes.
At most 100 active category/chart rows and the existing 65,536-byte whole-result
cap apply. Exceeding either fails explicitly; no hidden truncation is allowed.

`test/spending-analysis.test.mjs` tests independent invented amount/percentage
oracles, false-spike correction, report mismatches, negative/zero values, escaped
labels, bounds, cancellation, admission, revocation and complete orchestration.
Both SDK eras exercise the tool. Synthetic tests contain no owner data. Actual
client prompts and private comparisons against current YNAB reports/transactions
are separate release acceptance; publish only generic outcomes in Git/Jira.

## Chart presentation

See [the reconciled spending view](spending-view.md) for the standard MCP App,
private Claude Code capture preview, validation boundaries and client acceptance.
