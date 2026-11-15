# Runtime contracts for agents

These are mandatory constraints when changing runtime behavior, in addition to
[AGENTS.md](../AGENTS.md). Read the sections relevant to your change.

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
  supplied financial facts, parallel provider fan-out or partial/stale-on-error fallback.
  The hosted-only exception is at most four complete closed-period analysis snapshots
  in memory for 120 seconds from fetch start, never persisted; see the rate-limit
  safeguards in [analysis](spending-analysis.md). Original as_of/digest remain intact.
- Validate complete compatible reconciled evidence before producing any answer or
  chart. Fail closed on missing/inconsistent/oversized evidence, cancellation or
  revocation. Unknown is not zero; open months require explicit provisional opt-in.
- Canonical answer and inert SVG charts derive from the same checked integer facts.
  Preserve dates/currency, credits, signed values and complete labels; do not infer
  refunds or purchase purposes, invent a spike or hide mismatches with adjustments.
  Individual checked months do not constitute an atomic multi-month snapshot.
- External clients cannot be universally forced to use the returned answer or render
  SVG. Prefer supported native visualizations from the exact checked report facts;
  see [presentation](spending-view.md). Inspect actual tool calls and displayed
  values separately, preserve all rows and disclose rendering limits. Synthetic
  tests alone do not establish actual-data accuracy.

See [spending](spending.md), [analysis](spending-analysis.md) and
[live tools](live-tools.md) for the implemented contracts and bounds.

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

Read [hosting](hosting.md) and [recovery](recovery.md) before operational
changes, enrollment, key rotation or recovery. Preserve safe canonical-host static
pages and existing host/origin/readiness/admission protections.
