# ynab-mcp

A local, fixture-only MCP server and delivery checks for a future personal,
read-only YNAB service. Five tools expose invented plans, accounts, month values,
category metadata and transactions through an in-memory mock adapter. It is not connected to YNAB, Codex or ChatGPT, and is not hosted.
Authenticated Railway deployment and real client connections are later work.

## Set up or resume on another machine

1. Clone `https://github.com/tzehon/ynab-mcp.git` and open the checkout in Codex.
2. Inspect `git status --short --branch`, `git remote -v`, `git branch -a` and
   `gh pr list`. Preserve unrelated work; resume the matching issue branch/PR.
   Refresh a clean main using `git pull --ff-only` before a new issue branch.
3. Verify `gh api user --jq .login`. Set this repository's local Git identity:

   ```sh
   git config --local user.name 'tze hon'
   git config --local user.email '915365+tzehon@users.noreply.github.com'
   ```

4. Use Node **26.13.0** (`.node-version`) and npm **11.20.0**. Check `node --version`
   and `npm --version`; install that runtime with your usual version manager if needed.
5. Run:

   ```sh
   npm ci --ignore-scripts
   npm run check
   ```

6. Read `AGENTS.md`, the current Jira fields and owner approval comments. Revalidate
   approved fields against their Jira attachments. Existing Codex/Atlassian logins
   are machine/environment-specific; test the connector before adding another.

If an HTTPS push containing `.github/workflows/` is rejected for missing OAuth
`workflow` scope, run `gh auth refresh --hostname github.com --scopes workflow`
and complete GitHub's device authorization yourself. Retry the same feature-branch
push; do not remove the workflow or push main to work around the rejection.

No service tokens are required. Keep private account details in the 1Password
entry **YNAB MCP deployment** and local exports in ignored `.local/`. Never commit
live YNAB data, credentials or approval exports. Cloning proves repeatable local
checks; it does not establish a second machine's MCP connection.

## Run the local fixture server

After installing dependencies, use these explicit settings in one terminal:

```sh
LOCAL_FIXTURE_MODE=true DATA_MODE=fixtures NODE_ENV=development \
  HOST=127.0.0.1 PORT=3000 \
  FIXTURE_ALLOWED_PLAN_IDS='["fixture-plan-sgd","fixture-plan-usd"]' npm run dev
```

`dev` builds TypeScript and starts the compiled program; it is not a file watcher.
For a separate build/start workflow, run `npm run build`, then use the same
environment prefix with `npm start`. `.env.example` is a reference; no command
automatically loads `.env`. Stop with Ctrl-C (SIGINT); SIGTERM is also supported.

In a second terminal:

```sh
curl --fail http://127.0.0.1:3000/healthz
npm run smoke:mcp -- --url http://127.0.0.1:3000/mcp
```

Health returns `{"status":"ok","data_mode":"fixtures"}`. Smoke prints a pass for
each protocol era after checking all five tools, without dumping data. It uses the official SDK client, tests
discovery/list/call and schema validation, rejects redirects and any noncanonical
loopback URL, and bounds each HTTP operation to 5 seconds and the run to 20 seconds.
Allowlist at least one built-in plan for smoke (SGD is preferred, otherwise USD).
Smoke reads the synthetic November 2026 month/window. Deny-all is valid server
configuration, but smoke deliberately fails because it cannot exercise all tools.
A failed check exits nonzero with a generic diagnostic.

Both opt-in flags are required. `HOST` must be absent or literally `127.0.0.1`;
`PORT` defaults to 3000 and must be a decimal integer from 1 to 65535. `NODE_ENV`
may be absent, `development` or `test`. Production/unknown environments, live data
mode and a nonempty `YNAB_ACCESS_TOKEN` all fail before listening. These checks also
apply to `dev` and `start`; neither command silently enables fixture mode.

The allowlist is a JSON array of unique known fixture IDs. Missing or `[]` returns
no plans; malformed, duplicate or unknown IDs reject startup. The two built-in
plans are invented SGD/USD examples. Results are sorted by ID, bounded to ten
plans, marked `data_mode: fixtures` and `truncated: false`. The tool accepts only
an empty object (or omitted arguments), advertises read-only/non-destructive
annotations, and does not invoke the mock adapter. Annotations describe the
tool; schema validation and server behavior enforce its boundaries.

Only an exact `Host: 127.0.0.1:<port>` is accepted. Origin must be absent or exactly
`http://127.0.0.1:<port>`; proxy headers do not override these checks. The server
provides no authentication or CORS access. Do not expose it through a proxy,
tunnel, container public port or hosting service. Local programs can still access
it; its data is deliberately synthetic.

`POST /mcp` returns JSON using stateless requests. GET/DELETE on `/mcp` return 405;
there are no persistent SSE subscriptions. Legacy SDK initialization uses protocol
2025-11-25; modern SDK discovery uses 2026-07-28. Tests and smoke exercise both and
compare normalized logical results. SDK 2.4's stateless legacy handler emits a
finite SSE result even in JSON mode, so the HTTP adapter converts that terminal
event to JSON and redacts SDK error details while retaining protocol fields.
The SDK's static warning about dropped notifications is expected; these tools emit
none. This interoperability evidence is not a real Codex/ChatGPT connection test.

Bodies are limited to 65,536 bytes (larger bodies return 413). Every connection
closes after its response and has a 10-second total deadline, including incomplete
headers/bodies. Shutdown closes sockets and resources within 5 seconds. Diagnostics
contain fixed codes and the listening port, not request bodies, headers or secrets.

## Mock read tools

All five tools are read-only and require no service credential. The new tools
accept strict arguments with the existing public `fixture-plan-sgd` or
`fixture-plan-usd` IDs. Unknown/disallowed plans fail before transport dispatch.
The immutable fixture map supplies synthetic UUIDs, matching currency, and
`as_of: 2026-11-07T00:00:00Z`. This is a fixture timestamp, not live freshness.

| Tool | Arguments | Result semantics |
| --- | --- | --- |
| `ynab_list_plans` | `{}` or omitted | Original allowlisted local catalog |
| `ynab_list_accounts` | `plan_id` | Nondeleted accounts, including closed/off-budget accounts; exact balances |
| `ynab_get_month` | `plan_id`, `month` | Direct mocked month values; day must be 01 |
| `ynab_list_categories` | `plan_id` | Metadata only; hidden/internal flags and empty groups retained; no balances/goals/notes |
| `ynab_list_transactions` | `plan_id`, `since_date`, `until_date`, optional `limit` | Nondeleted, non-pending records; splits nested and transfers retained |

Dates are real `YYYY-MM-DD` values in 2000–2099. Transaction windows are inclusive,
1–90 days; limit is an integer 1–100, default 50. Results sort date descending then
ID ascending. `available_count` counts matching records in the bounded mock
response; `returned_count` is emitted length and `truncated` indicates a limit cut.
Narrow a truncated window or increase limit; there is no cursor or guarantee of
complete retrieval through pagination. `pending_excluded: true` does not mean all
returned transactions are cleared or approved. Deleted children disappear without
rebalancing their parent; transfer pairs need not both be present.

Every new success has `data_mode: fixtures`, `source: mock-ynab`, public plan ID,
currency, synthetic timestamp and truncation flag. Money remains signed safe
integer `*_milliunits` (1000 = one currency unit). No rounding, currency conversion,
spending classification, cross-record totals or transaction-derived month totals
are performed. Instruction-like names/memos remain inert JSON text.

The injected mock consumes fixed GET descriptors for accounts, months, categories
and transactions at the YNAB origin **without issuing network requests**. It returns
HTTP-like status/headers and byte chunks; the adapter validates and projects them.
Wire shape reference: [official schema](https://api.ynab.com/papi/open_api_spec.yaml),
version 1.89.0 inspected on 2026-11-07. This is mocked contract evidence, not live
API validation. No environment or tool argument selects another transport.

Each call has one attempt, a three-second absolute deadline and a shared process
budget of four active adapter calls. Excess calls return `BUSY`; cancellation and
shutdown release capacity even if a mock ignores abort. There are no retries,
caches or persistent state. Raw JSON is bounded to 1 MiB before parsing, with caps
of 200 accounts, 100 groups/1000 categories, 1000 month categories, and 1000 parent
transactions/100 children each/2000 children total. Validation precedes deletion
and date filtering. Duplicate IDs, inconsistent parent references and invalid
consumed fields fail the whole call. Extra unconsumed wire fields are discarded.
Normalized compact JSON is bounded to 65,536 UTF-8 bytes; its matching MCP text
copy adds protocol overhead. Oversize results fail instead of returning partial rows.

Application failures contain only `isError: true` and one JSON text block with a
fixed error code/message, with no success-shaped structured content. Denials,
not-found, upstream status errors, timeouts, malformed/oversized responses, oversized
results and busy capacity are distinguishable. Upstream bodies, headers and exception
text never enter diagnostics. SDK validation failures retain generic redaction.

## Checks and supported dependencies

Exact versions are locked: server/client SDK 2.4.0, Node adapter 2.1.2, Zod 4.6.7,
TypeScript 7.0.2, Node types 26.6.6 and Biome 2.6.6, on Node 26.13.0/npm 11.20.0.
Install with lifecycle scripts disabled as shown above.

| Command | Behavior |
| --- | --- |
| `npm run typecheck` | Strict TypeScript checks, no output |
| `npm run lint` | Recommended Biome rules; warnings also fail |
| `npm run build` | Compile runtime sources into ignored `dist/` |
| `npm test` | Build, then run all delivery and fixture tests |
| `npm run check` | Typecheck, lint and test (including build) |
| `npm run dev` / `npm start` | Build-and-start / start existing compiled output |
| `npm run smoke:mcp -- --url <endpoint>` | Real local SDK smoke for both eras; build first |
| `npm run check:pr -- --event <path>` | PR metadata and real Git-range validation |

Tests use synthetic inputs and ephemeral loopback listeners. They include process
startup/shutdown, protocol and HTTP error paths, allowlist isolation, slow requests
and smoke failures. A test-only preload blocks outbound I/O, persistent writes and
subprocesses before importing the running server; positive controls prove the guard
detects attempts. Test infrastructure itself writes temporary Git repositories and
build output. The guard and source audit check the exercised fixture runtime, not
every possible behavior of third-party dependencies.

## Run the metadata checker

An offline synthetic demonstration needs no Jira login or Git history:

```sh
JIRA_BASE_URL=https://example.invalid npm run check:pr -- \
  --event test/fixtures/valid-event.json --fixture-commits test/fixtures/commits.json
```

This exits 0. Replace `valid-event.json` with `invalid-event.json` to see a missing
title-key error and exit 1. These fixtures are synthetic, including their approvals.
Fixture commits are prohibited when `CI` or `GITHUB_ACTIONS` is set.

For a real PR, privately export GitHub's pull-request webhook JSON to `.local/`
(containing `action`, `pull_request.title`, `.body`, `.base.sha` and `.head.sha`).
Set `JIRA_BASE_URL` in the process environment from your private register, using
the exact HTTPS origin without a path. Then run:

```sh
npm run check:pr -- --event .local/pr-event.json
```

Use a full checkout containing both event SHAs. The checker collects **every**
real commit in `base.sha..head.sha`; all must contain the exact primary issue key.
It deliberately uses the event head, not checkout HEAD, to exclude GitHub's
synthetic test merge. No contributor/merge commit is exempt. Missing, shallow,
unrelated or empty history fails. Git runs through argument arrays without a shell.

In Actions, the event comes from `GITHUB_EVENT_PATH` and the origin comes from the
repository Actions secret `JIRA_BASE_URL`. Missing configuration fails explicitly.
The origin is not a credential; secret storage prevents GitHub's step environment
listing from printing it. Keep its exact HTTPS origin in the private register;
an administrator can set it with `gh secret set JIRA_BASE_URL` from this checkout
and enter the value at the private prompt. Do not place it in committed fixtures
or print it. Fork PRs do not receive this setting and fail closed; they require
maintainer review and an approved same-repository branch, never a privileged
`pull_request_target` workaround. No Jira API credentials are used by CI.
Full Jira links intentionally appear in the public PR for traceability; keep
snapshot contents and private configuration outside Git. Jira access still requires
the viewer's own permission.

## PR metadata format

Fill out `.github/pull_request_template.md`. Keep exactly one fenced
`ynab-metadata` JSON block, schema version 1, with:

- `issueUrl`: exact configured HTTPS origin and `/browse/YNAB-<number>` matching
  the single primary key in the title `YNAB-<positive integer>: <summary>`.
- `approvals.spec`, `.ac` and `.plan`: each has `revision`, `snapshotUrl` and
  `decisionUrl`. Use same-site attachment URLs and decision links to the same
  issue with `?focusedCommentId=<comment-id>`. Replace all placeholders.
- `acceptanceCriteria`: exactly one entry each for `AC-1` through `AC-9` on YNAB-3.
  The existing eight-entry contract remains for other issues. Each entry has `id`, a specific `check`, `status` and `evidence`.
  Status is `passed`, `failed` or `pending`; pending also requires `remaining`.
  Later issues with different AC sets require an explicit validator change. The
  issue-specific nine-entry rule accommodates the approved adapter contract; it
  does not make AC coverage optional or alter approval/commit validation.

Malformed data, failed ACs, missing commit keys or missing trusted configuration
exit 1. Pending evidence is accepted for work in review, printed separately, and
**never counts as a pass or completion**. All ACs must pass before Done.

These checks validate syntax, not Jira existence, approval authorship, evidence
truthfulness or equality with current Jira fields. The owner/agent must perform
the authenticated checks manually. No Jira/YNAB/OpenAI API credentials enter CI.

## Review, traceability and completion

Use issue-keyed branches, commits and PR titles, plus full Jira links in the PR.
Verified navigation on the bootstrap PR:

- Jira issue → **Development** → PR details → **View pull request**.
- Jira issue → **View development activity** → **Commits** → commit hash.
- GitHub PR → the **YNAB-1** link in its description → Jira issue.
- GitHub commit page → associated **#1** PR link → **YNAB-1** link → Jira issue.

The commit title itself was plain text in the observed GitHub UI; use its
associated PR for the two-click return path. The numeric autolink also supports
issue-key references in supported GitHub text. Native sync can take time;
missing links are unfinished verification, not proof of success. Use the actual
issue and PR numbers for later work. Delivered-commit navigation must be checked
again after merge.

`PR checks` runs `bootstrap-tests` and `pr-metadata` for PR opened, synchronize,
reopened and edited events against main, with read-only permissions and pinned
Actions. A push to main runs application checks; PR metadata is skipped for that
event. The metadata job reports the event and head SHA; superseded runs cancel.
Require these exact job names in main's ruleset after their first successful run.
A PR can change its own checker/workflow, so passing CI is not independent proof
that the checks remained intact. Review those diffs explicitly.

Before requesting the owner's merge decision:

1. Compare live Jira fields with approved snapshots and verify human decision
   authors/revisions. Jira edits do not automatically rerun GitHub CI.
2. Check final-head tests, the latest title/body-edit run and native Codex review.
   Every later push needs fresh review; resolve relevant findings.
3. Verify Jira → PR/branch commit and GitHub PR/commit → the same Jira issue.
4. Report pending post-merge checks honestly. Obtain the owner's explicit merge
   decision. Rebase-merge and retain the issue key in every delivered commit.
   Never push main.
5. After merge, verify the delivered commit and merged PR appear in Jira and link
   back correctly. Record the delivered SHA and final evidence for every AC.
   Confirm main CI and equivalent delivered changes, then delete the merged remote
   and local branches and refresh local main. Only mark the issue Done when every
   AC has evidence. Merge and release remain separate owner decisions.

The guided setup and checkpoint register live in
[the research guide](https://github.com/tzehon/research/tree/main/ynab-mcp-sdlc-guide).
Current specifications and approval snapshots remain in Jira.

Before reporting Jira closure, independently read status, resolution and
resolutiondate after the transition. Require Done/status category done, Resolution
Done with an ID, and a populated resolution date. A successful transition response
alone is insufficient. At resume and after closure/reopening, paginate the project
query for `(statusCategory = Done AND resolution IS EMPTY) OR
(statusCategory != Done AND resolution IS NOT EMPTY)`. Missing fields/errors leave
closure unverified; reopening must clear resolution and its date. Do not bulk-close
unrelated issues. This is an agent check, not an authenticated CI assertion.
