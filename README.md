# ynab-mcp

The [injected read-only HTTP transport](docs/ynab-http-transport.md) provides a
bounded adapter tested against local mock servers. It is not wired into runtime
modes; all current tools still serve fixtures.

Hosted integrated authorization is under development in YNAB-6. See
[hosting](docs/hosting.md) and [recovery](docs/recovery.md) for the explicit mode,
private enrollment and release gates. All tools still use synthetic fixtures.
Local modes retain the restrictions below. No live deployment is implied.

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

After installing dependencies, run the self-contained authenticated test harness:

```sh
npm run build
npm run smoke:auth-fixtures -- --mode start
npm run smoke:auth-fixtures -- --mode dev
```

Each run generates disposable RSA keys in memory, writes only a public fixture
bundle to temporary scratch, starts the protected service, exercises all five
tools in both protocol eras and missing/expired/wrong-owner rejection, then shuts
down and cleans up. It prints only fixed success/failure labels. This is a local
mock test, not Auth0 login or actual Codex/ChatGPT acceptance.

**Migration:** the previous anonymous start/dev commands now fail closed. For
manual protected operation, provide every setting explicitly (synthetic values
only):

```sh
LOCAL_FIXTURE_MODE=true DATA_MODE=fixtures NODE_ENV=development \
  HOST=127.0.0.1 PORT=3000 \
  AUTH_ISSUER=https://issuer.example.test/ \
  AUTH_AUDIENCE=http://127.0.0.1:3000/mcp \
  MCP_PUBLIC_URL=http://127.0.0.1:3000/mcp \
  AUTH_ALLOWED_SUBJECT=synthetic-owner \
  AUTH_FIXTURE_FILE=/absolute/private/scratch/public.json \
  FIXTURE_ALLOWED_PLAN_IDS='["fixture-plan-sgd","fixture-plan-usd"]' npm run dev
```

The bundle is a regular, nonsymlink JSON file at most 65536 bytes with exactly
`discovery` and `jwks` objects. Discovery has exact issuer and
`https://issuer.example.test/.well-known/jwks.json`, same-origin HTTPS
`authorization_endpoint`/`token_endpoint`, `response_types_supported: ["code"]`
and `code_challenge_methods_supported: ["S256"]`. JWKS has 1–8 unique public RSA
signing keys (`kid`, `kty: RSA`, `alg: RS256`, `use: sig`, 2048–4096-bit `n`, `e`;
optional verification-only `key_ops`). No private/symmetric key fields are
accepted. It is read once, before listening; mock retrieval never contacts these
URLs. Private test keys stay in your test harness, never in this bundle/server.
The reproducible commands above prepare this material automatically.

`dev` builds and starts, without a watcher. `start` uses a prior build. `.env`
is never loaded automatically. Both opt-in flags are mandatory; live mode,
production/unknown NODE_ENV, non-loopback HOST and nonempty YNAB_ACCESS_TOKEN fail.
PORT is 1–65535 (default 3000); both resource settings must match its exact URL.
Issuer is the fixed test issuer, and the explicit owner subject has no default.

GET/HEAD `/healthz` is public. The challenge from an unauthenticated `/mcp`
request identifies `/.well-known/oauth-protected-resource/mcp`, also public.
Every MCP request needs a signed RS256 RFC 9068 access token (`typ: at+jwt` or
`application/at+jwt`) with exact issuer/resource/owner and `ynab:read`. Signature,
claim types, expiry/not-before/issued-at and token type are checked on every call,
with zero clock tolerance. ID tokens and generic JWTs are not accepted. Later
Auth0 setup must configure and independently verify the selected profile.

`smoke:mcp -- --url http://127.0.0.1:3000/mcp` reads one bounded synthetic token
from stdin; never put it in command arguments or logged environment variables.
The harness pipes it privately. Smoke requires at least one built-in allowed
plan, checks all five tools in both protocol eras, and emits no financial data.
It limits HTTP operations to 5 seconds and the run to 20 seconds. No application
endpoint mints tokens. Stop the manual service with Ctrl-C or SIGTERM.

The allowlist is a JSON array of unique known fixture IDs. Missing or `[]` returns
no plans; malformed, duplicate or unknown IDs reject startup. The two built-in
plans are invented SGD/USD examples. Results are sorted by ID, bounded to ten
plans, marked `data_mode: fixtures` and `truncated: false`. The tool accepts only
an empty object (or omitted arguments), advertises read-only/non-destructive
annotations, and does not invoke the mock adapter. Annotations describe the
tool; schema validation and server behavior enforce its boundaries.

Only an exact `Host: 127.0.0.1:<port>` is accepted. Origin must be absent or exactly
`http://127.0.0.1:<port>`; proxy headers do not override these checks. The server
enforces local mock authentication and provides no cross-origin access. Do not
expose this test-key service through a proxy, tunnel, public container port or
hosting service; real provider/hosted authorization is a later milestone.

`POST /mcp` returns JSON using stateless requests. Authenticated GET/DELETE on `/mcp` return 405;
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
contain fixed codes, server-generated request IDs, status/duration and registered
tool names after authorization, not bodies, raw headers/URLs, claims or secrets.
Missing/invalid access returns 401, wrong owner or insufficient scope returns 403.
Auth overload/deadline returns 503. Four auth operations and one shared key refresh
are bounded to 2 seconds with no admission queue. Key freshness is at most 60
seconds; unknown-key refresh has a global 5-second cooldown. Removed keys cease
working after refresh/expiry; this is not instant revocation. No stale-on-error
fallback, token cache, persistent cache or outbound auth retrieval exists.

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
  YNAB-5 requires AC-1 through AC-11; the existing eight-entry contract remains for other issues. Each entry has `id`, a specific `check`, `status` and `evidence`.
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

## Integrated authorization with a mocked YNAB provider

This local-only mode uses oidc-provider 9.13.3 and oauth4webapi 3.8.8. It adds an
explicit client consent form, a synthetic YNAB authorization page, verified mock
owner identity, and a separate MCP token. It does not connect to YNAB, Google,
Auth0, Codex or ChatGPT accounts. Earlier fixture-token instructions above remain
valid and describe that mode; these are its narrowly approved additional I/O paths.

```sh
npm ci --ignore-scripts
npm run build
npm run smoke:auth-integrated -- --mode start
npm run smoke:auth-integrated -- --mode dev
```

The harness generates private synthetic keys in a temporary owner-only directory,
starts the independent loopback mock, runs the actual start/dev process and
submits the real consent forms for public-native and confidential-web clients.
It exercises all five tools through both official SDK protocol eras and removes
its temporary state. Only a fixed pass/fail line is printed by the command.

For implementation tests, AUTH_MODE=integrated-mock requires the usual fixture
flags, a literal loopback PORT and matching AUTH_ISSUER (origin without trailing
slash), AUTH_AUDIENCE/MCP_PUBLIC_URL (origin plus /mcp), synthetic owner UUID,
MOCK_YNAB_ORIGIN (separate loopback origin with trailing slash), exact
OAUTH_NATIVE_CALLBACK/OAUTH_WEB_CALLBACK, OAUTH_STATE_DIR, OAUTH_KEY_FILE,
OAUTH_WEB_SECRET and MOCK_YNAB_SECRET. Synthetic secrets have the prefix
synthetic- and 64 hexadecimal characters; use the harness instead of inventing
real deployment settings. DEBUG, production/live/PAT configuration and public
origins are refused. A fixture plan allowlist remains mandatory for useful tools;
an empty one grants no plan access.

Keys and the SQLite directory are separate and owner-only. Application state is
AES-256-GCM encrypted before entering SQLite/WAL; operational expiry/model,
consumption flags and keyed lookup identifiers remain visible. The database is
schema-versioned, limited to 1,000 records/64 KiB payloads and a 32 MiB storage
budget with admission reserve. SQLite uses local WAL/FULL durability. A wrong
key, corrupt schema/payload, store failure or missing private directory fails
closed. The application never invents replacement keys or falls back to memory.
Keep the same temporary keys for restart tests. Do not restore old grants or
backups to work around an error; terminate the harness and generate a fresh
synthetic setup. Signing rotation tests retain old/new public keys for overlap;
production key custody and storage-key rotation are future work.

Every client authorization requires explicit consent; upstream state and PKCE
are separate from the MCP client leg. Callback processing returns to the
engine's interaction path so its path-scoped cookie remains effective. The
connection page offers CSRF-protected refresh and disconnect. Refresh is
serialized; ambiguous exchange/crash requires reconnect. Disconnect invalidates
stored downstream grants, so even an unexpired signed MCP token fails on the next
request. Local deletion does not claim provider-side revocation. MCP tokens last
at most one hour and have no refresh token in this slice. Fixture tools never
use the stored upstream grant or make token/user/budget requests.

The integrated audit preload intercepts native SQLite imports as well as
JavaScript I/O, blocks unapproved database paths and ATTACH, and verifies exact
mock endpoints. This is trusted-code regression instrumentation, not a security
sandbox for malicious packages. The engine may print a fixed notice about the
bounded upstream form parser; raw request/error/debug logging is disabled or
sanitized, and credentials are checked with output canaries.

Real-provider interoperability, actual Codex/ChatGPT connections, HTTPS hosting,
Railway storage/costs, production key management and live budget reads remain
separate milestones. Do not proxy or deploy either local mode.

Browser consent checks preserve `Referrer-Policy: no-referrer`. Chromium form
navigation can therefore send `Origin: null`; only cookie/CSRF-bound interaction
and owner-control POSTs accept it with the full `Sec-Fetch-Site: same-origin`,
`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` tuple. This exception never
applies to MCP or token endpoints. The consent form permits only its configured
mock-provider and registered callback origins in `form-action`; owner-control
forms remain self-only. Browser flow bindings persist across pending tabs, while
a separate owner-session cookie rotates on completed authorization. Binding
cookies alone never authorize connection controls. HTTP regression tests cover
both tabs completing, preselected-cookie rejection and hostile navigation headers;
real Chromium consent, denial, refresh and disconnect were also manually verified.

## Live owner integration

See [live setup and limits](docs/live-tools.md), [service information](docs/public-service/README.md) and [privacy policy](docs/public-service/PRIVACY.md). Actual hosted/client qualification is tracked separately from synthetic test results.
