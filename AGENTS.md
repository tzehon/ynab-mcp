# Working on ynab-mcp

## Authority and source of truth

The owner authorizes implementation, reviewed PRs, fixes, rebase merges, cleanup,
deployment and actual owner-only reads. Ask only for necessary human intervention
or commitments outside that scope. Record concrete decisions in Jira as delegated
approvals; never imply the owner personally posted them.

Jira owns intent, Spec, Plan, AC and decisions. Read the issue/comments at task
start; compare live fields with the approved, independently verified snapshot
before implementation, publication and merge. Record revised scope/approval for
substantive changes; record minor discoveries without a second editable spec.
Preserve unrelated work. Keep PROGRESS.md and private release evidence current.

## Delivery

- Use issue-keyed branches, commits and PR titles. Fill the
  [PR metadata](docs/contributing.md#pr-metadata-format) with full Jira links,
  snapshot/revision/decision links and truthful per-AC evidence.
- Never push main, force-push shared history, bypass protection or use automatic
  merging. Complete native Codex cloud **code and security reviews on the final
  head**, including every later push; resolve findings and pass required CI plus
  the latest metadata-edit run. Metadata validation checks syntax, not truth.
- Recheck Jira fields/decisions, record the delegated merge decision, rebase-merge,
  then verify delivered tree/patch equivalence, main CI and native Jira links both
  ways. Delete remote/local branches only after equivalence is proven.
- Deployment is a separate delegated decision after preflight. Use exact clean
  source; verify revision, preserved settings, health and actual-client behavior.
  Merge, synthetic tests or a healthy fixture server do not prove live acceptance.
- After Done, independently read status Done/category `done`, Resolution Done
  with ID and populated `resolutiondate`. At resume and after closure/reopening,
  paginate the project audit for Done with empty resolution or non-Done with a
  resolution. Errors/missing fields do not pass; reopening must clear resolution
  and date. Never mark unverified ACs passed or bulk-close unrelated work.

## Product, data and hosting

- Preserve read-only, owner-bound OAuth and explicitly selected plans. Test the
  requested client route; never mask failures with another route's credentials.
  Shared **MCP Tools for YNAB** is the preferred Codex/ChatGPT route.
- Code/tests use invented data and credentials. Actual finances, plan IDs, secrets,
  configuration and provider investigations stay in protected private evidence or
  1Password, never Git, Jira, fixtures or logs. Public progress is generic.
- Use only the existing Railway service and free credits. No paid plan/card/top-up
  or new provider resource without specific authorization. Preserve one replica,
  private volume/keys, owner/grants/selection and disconnected source. Do not revive
  expired shutdown limits; retain the separately recorded hosted qualification gap.
- Spending answers/charts use complete, validated `ynab_get_spending_analysis`
  results, never raw month activity or client-recomputed sums. Preserve exact
  signed facts, dates/currency, credits, labels and provenance; unknown is not zero.
  Native visuals may change presentation, not financial facts. Verify actual tool
  calls and displayed values separately for each requested client.

## Development and verification

Read [runtime contracts](docs/development-contracts.md) before changing runtime
behavior, and [hosting](docs/hosting.md)/[recovery](docs/recovery.md) before
operations, enrollment, rotation or recovery. These constraints are mandatory.
Local fixture-token and integrated-mock modes must never be exposed publicly.

Use the pinned Node/npm versions and lockfile: `npm ci --ignore-scripts`.
Run `npm run check` plus affected checks and required delivery gates in
[local development](docs/local-development.md). Do not weaken checks for green CI;
justify changed expectations against the contract. Report actual commands/results,
reviewed/tested/delivered SHAs and remaining gaps. No tests need to be added merely
to mirror a documentation edit.
