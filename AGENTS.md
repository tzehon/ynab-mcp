# Working on ynab-mcp

## Authority and delivery workflow

The owner authorizes Codex to record approvals on their behalf and continue through
implementation, reviewed PRs, fixes, rebase merges, branch cleanup, deployment and
actual owner-only reads. Ask only for necessary human intervention or a commitment
outside the authorized scope. Record each concrete scope/revision and decision in
Jira as a delegated approval; never imply the owner personally posted it.

Jira owns current intent, Spec, Plan, Acceptance criteria and decisions. At task
start, read the issue and approval comments. Compare live fields with the approved,
independently verified snapshot before implementation, publication and merge.
Substantive changes require a revised scope and recorded approval under the owner's
authorization. Record minor discoveries without creating a second editable spec.

- Use an issue-keyed branch, commits and PR title. Include the full Jira issue URL,
  snapshot/revision/decision links and truthful per-AC evidence in the PR template.
  Resolve private site identifiers from the connected issue/private register.
- Never push directly to main, bypass protection, force-push shared history or use
  automatic merging. Resolve findings and complete native Codex cloud **code and
  security reviews on the final head**, including every later push. Confirm required
  CI and the latest metadata-edit run. The metadata validator checks syntax, not
  approval authenticity or evidence truth.
- Recheck live Jira fields/decisions, record the delegated merge decision, then
  rebase-merge. Verify delivered tree/patch equivalence, main CI and native Jira
  links in both directions. Delete remote/local feature branches after equivalence
  is proven. Preserve unrelated work.
- Record deployment as a separate delegated decision after release preflight.
  Deploy an exact clean source archive and verify the delivered revision, settings,
  health and actual-client behavior. Merge or a healthy fixture server is not live
  financial acceptance. Never mark an unverified AC passed.
- Before claiming Done, independently read status/category, resolution (Done with
  ID) and populated resolutiondate after transition. At resume and after closure or
  reopening, paginate the project audit for Done with empty resolution or non-Done
  with a resolution. Missing fields/errors do not pass. Reopening must clear both
  resolution and date. Do not bulk-close unrelated issues.

## Current product and privacy boundaries

The deployed product is a read-only, owner-bound MCP service with integrated YNAB
OAuth and explicitly selected plans. The shared **MCP Tools for YNAB** plugin is the
preferred everyday route in ChatGPT and Codex. Native protocol support remains in
source and tests; test the route actually requested, without using another route's
credentials to mask failures. Client setup and acceptance are distinct.

Use invented financial data and credentials in code, tests and fixtures. Actual
financial records, values, selected-plan identifiers, credentials and provider
investigations belong only in protected private evidence/1Password, never Git,
Jira, fixtures or logs. Public progress contains generic outcomes. Do not print
runtime variables, OAuth tokens, private configuration or raw financial responses
into command/CI logs.

Hosting is the existing Railway service on **free credits only**: no paid plan,
card, top-up or new provider resource without specific authorization. Preserve its
single replica, private volume/keys, owner/grants/selection and disconnected source.
Do not silently reintroduce expired historical shutdown limits. The earlier hosted
qualification gap remains incomplete even though its task was administratively
closed. Use current Jira/release evidence; Git history retains older milestones.

## Spending correctness

There are seven read-only tools. For spending answers, comparisons and charts use
`ynab_get_spending_analysis`, not raw month activity or a client-reconstructed sum.
Raw activity includes credit-card payment bookkeeping. Monthly reports are source
inspection; transaction pages are drill-down, with nested splits preserved.

- The monthly report uses five sequential fixed provider GETs within one admission
  slot and one absolute three-second deadline, bounded raw/output sizes, checked
  integer milliunits and per-category reconciliation. No partial result or retry.
- Analysis accepts one through six explicit consecutive months and retrieves those
  reports sequentially, with a nine-second overall deadline inside the existing
  ten-second HTTP connection limit. Preserve the four-call process budget, per-month
  limits, generation/owner/selection checks and fixed upstream routes. No caller-
  supplied financial facts, financial cache, parallel provider fan-out or fallback.
- Validate complete compatible reconciled evidence before producing any answer or
  chart. Fail closed on missing/inconsistent/oversized evidence, cancellation or
  revocation. Unknown is not zero; open months require explicit provisional opt-in.
- Canonical answer and inert SVG charts derive from the same checked integer facts.
  Preserve dates/currency, credits, signed values and complete labels; do not infer
  refunds or purchase purposes, invent a spike or hide mismatches with adjustments.
  Individual checked months do not constitute an atomic multi-month snapshot.
- External clients cannot be universally forced to use the returned answer or render
  SVG. Inspect actual tool calls and displayed values separately. Disclose rendering
  limits instead of inventing replacement visuals. Synthetic tests alone do not
  establish actual-data accuracy.

See [spending](docs/spending.md), [analysis](docs/spending-analysis.md) and
[live tools](docs/live-tools.md) for the implemented contracts and bounds.

## Authentication, modes and runtime guards

Preserve strict schemas, fixed errors, exact owner/resource/token-type checks and
bounded discovery/JWKS validation. Do not put raw Authorization or SDK AuthInfo in
tool context, add remote resolver fallbacks, enable DEBUG or auto-consent.

- **Fixture-token:** requires LOCAL_FIXTURE_MODE=true, DATA_MODE=fixtures, literal
  loopback binding and explicit public fixture authentication. Reject live settings
  and YNAB_ACCESS_TOKEN. Only auth/fixture-bundle.ts reads the bounded public bundle.
  Application execution has zero persistent writes, outbound calls or subprocesses.
  Never expose the fixture server through a proxy, tunnel or hosting service.
- **Integrated-mock:** separate local exception permits only injected mock-loopback
  OAuth/control calls, encrypted SQLite state and a bounded private synthetic key
  file. Never deploy this mode or copy real credentials into it.
- **Integrated-hosted:** explicit production opt-in, configured keys and existing
  owner-bound OAuth are required. The approved live path additionally requires
  DATA_MODE=live and LIVE_YNAB_ENABLED=true; only its bounded fixed-origin GET
  catalog/selected-plan transport reads budget data. Hosted control-plane token
  POST/user GET calls remain separate from budget transport.
- Only oauth/store.ts accesses SQLite, oauth/keys.ts reads private keys,
  oauth/process-lock.ts manages the private claim and oauth/hosted-admin.ts owns the
  private Unix socket. Preserve mode-specific I/O guard exceptions and positive
  denial tests, including native SQLite imports/ATTACH. These guards instrument
  trusted code; they are not a malicious-dependency sandbox. Never steal a claim
  on a timer or restore old grants during recovery.

Read [hosting](docs/hosting.md) and [recovery](docs/recovery.md) before operational
changes, enrollment, key rotation or recovery. Preserve safe canonical-host static
pages and existing host/origin/readiness/admission protections.

## Verification commands

Use the pinned package/lockfile and supported Node/npm versions documented in
README. `npm ci --ignore-scripts` installs exact dependencies. Relevant commands:

- `npm run check`: strict typecheck, lint, build and all tests, including real HTTP
  and both official SDK eras. Loopback listening must be available.
- `npm run smoke:auth-fixtures -- --mode start` and `--mode dev`.
- `npm run smoke:auth-integrated -- --mode start` and `--mode dev`.
- `npm run smoke:auth-hosted` and `npm run check:container` use disposable synthetic
  state/keys; preserve recovery, encryption, consent, revocation and logging checks.
- `npm run smoke:mcp -- --url http://127.0.0.1:3000/mcp` requires a built protected
  fixture server, synthetic token on stdin and an allowed built-in plan.
- `npm run check:pr -- --event <path>` requires full Git history and trusted private
  JIRA_BASE_URL; README provides offline fixtures.

Run affected checks and all required delivery gates. Do not weaken tests to make
CI green; justify expectation changes against the contract. Report commands actually
run, reviewed/tested/delivered SHAs and remaining gaps. Keep PROGRESS.md and private
release evidence current without exposing financial data or secrets.
