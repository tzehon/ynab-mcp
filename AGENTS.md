# Working on ynab-mcp

Jira is authoritative for current intent, Spec, Plan, Acceptance criteria and
human decisions. Read the issue and its approval comments at task start; compare
live fields to approved snapshots before implementation and publication.
Historical snapshots are evidence. Do not keep a second editable specification
in this repository or treat an agent draft/status transition as owner approval.
Substantive changes need revision and renewed approval; record minor discoveries.

Use the existing YNAB issue and an issue-keyed feature branch. Every development
commit and PR title carries its primary key, e.g. `YNAB-1: Add metadata checks`.
Put the full Jira issue URL, revision/snapshot/decision links and evidence for
each AC in the PR template. Resolve the Jira site through the connected issue
or private register; never guess it or commit site configuration/approval exports.
Never push directly to main, bypass protection, force-push shared history or
auto-merge. Reuse a matching branch/PR when resuming.

Native Codex cloud review must cover the final head, including later pushes.
Resolve findings, rerun affected checks and confirm the latest metadata-edit run.
Immediately before merge, manually recheck Jira approval authors, revisions and
live fields, then obtain the owner's explicit merge decision. Merge/release are
separate decisions; Done requires all ACs complete, including delivered traceability.

Available commands (Node 26.13.0 / npm 11.20.0):

- `npm ci --ignore-scripts`: install exact dependencies from the lockfile.
- `npm run check`: strict typecheck, Biome lint and all tests (including build).
- `npm test`: build and run delivery, configuration, tool, real HTTP/SDK, process,
  runtime I/O guard and smoke tests. Loopback listening must be available.
- `npm run build` / `npm start`: compile to ignored dist, then run compiled code.
- `npm run dev`: build then start; no watcher and no hidden environment defaults.
- `npm run smoke:mcp -- --url http://127.0.0.1:3000/mcp`: both official SDK eras;
  requires a build, protected fixture server and synthetic token on stdin. No plan data in output.
- `npm run smoke:auth-fixtures -- --mode start` (or `dev`): disposable authenticated
  harness; private keys stay in memory, public-only bundle cleaned after use.
- `npm run check:pr -- --event <path>`: validate a PR event with full Git history;
  requires trusted `JIRA_BASE_URL` in the environment. See README for offline fixtures.

Runtime dependencies: jose 6.2.15, server/client SDK 2.4.0, Node adapter 2.1.2 and Zod 4.6.7;
tooling: TypeScript 7.0.2, Node types 26.6.6, Biome 2.6.6. See README for settings.
Both LOCAL_FIXTURE_MODE=true and DATA_MODE=fixtures are mandatory. Bind literally
127.0.0.1; production/live configuration and a nonempty YNAB_ACCESS_TOKEN fail.
Missing/empty allowlist denies all plans. Explicit auth configuration/public fixture
bundle is mandatory; anonymous start/dev now fails. See README for all settings.
Never expose this local test-key fixture server through a proxy, tunnel or hosting service. No deployment command exists.
All five tools are read-only; test legacy initialize and modern discovery over
real HTTP. SDK interoperability does not prove actual Codex/ChatGPT connectivity.

Report commands actually run,
results, reviewed/tested SHAs and pending ACs. Keep pending distinct from passed.
Never weaken checks to make CI green; justify test changes against requirements.
The validator checks syntax only: human approval, Jira existence and evidence
truthfulness require manual verification. Review changes to the validator/workflow
as carefully as other code; a PR can change its own checks.

Use synthetic data only. Keep credentials, personal financial data, actual Jira
snapshots and private configuration out of source, tests and logs. Use 1Password
for private details and ignored `.local/` for local scratch. No service credential
is needed for fixture operation. Do not create YNAB/Auth0/Railway resources for this issue.

New read tools use only the required injected mock transport. Preserve strict
schemas, pre-dispatch allowlisting, exact safe integer milliunits, synthetic currency
and timestamp context, nested splits, metadata-only categories and truthful
truncation. No inferred totals, retries, live fallback or persistent budget state. Keep the
four-call process budget, three-second deadline, raw/output caps and canonical
fixed errors. Smoke requires at least one allowed built-in plan and exercises all
five tools without logging their data.

Before claiming Jira completion, directly read status, resolution and resolutiondate
independently after transition: require Done/category done, Resolution Done with
ID, populated resolutiondate. At resume and after closure/reopening, paginate the
project query for Done-with-empty-resolution or non-Done-with-resolution. Missing
fields/errors do not pass. Reopening must clear resolution and date. Preserve
unrelated work; do not bulk-close issues. These are manual agent checks, not CI.

Authentication uses required injected mock discovery/JWKS only, with bounded
refresh/admission and exact owner/resource/type checks. No remote resolver or
fallback. Keep raw Authorization and SDK AuthInfo out of protocol/tool context.
Only auth/fixture-bundle.ts may read the bounded public bundle; the application
must still perform zero persistent writes, outbound calls or subprocess creation.
The test harness may orchestrate children/create public scratch outside the guarded
application. Preserve positive controls for every runtime-guard exception.

YNAB-5 integrated-mock mode is a separately approved local-only exception:
AUTH_MODE=integrated-mock permits exact mock-loopback OAuth/user control calls
and encrypted SQLite state under OAUTH_STATE_DIR, plus the bounded separate
OAUTH_KEY_FILE. The existing fixture-token mode retains its previous zero-write,
zero-outbound rules. Only oauth/store.ts accesses SQLite, oauth/keys.ts reads
private synthetic keys, and oauth/upstream.ts sends mock control traffic. Preserve
negative controls for native SQLite imports/ATTACH as well as JS fs/network.
The guards instrument trusted code; they are not malicious-dependency sandboxes.

Use npm run smoke:auth-integrated -- --mode start (or dev) for disposable local
consent/code/PKCE, both client profiles and both SDK eras. It creates only invented
identities and temporary keys/state and cleans them up. Never deploy this mode,
copy real credentials into it, enable DEBUG, or substitute auto-consent. Tests must
prove encrypted persistence, single-use code/state, owner binding, refresh races,
reconnect, disconnect invalidation and no secret logging. No MCP refresh tokens
are issued in this slice; upstream refresh is independent. Full plan/AC evidence
and separate owner merge authorization are still required.

YNAB-6 plan-r1 authorizes local synthetic implementation and PR publication for
hosted authorization. The new hosted-only process-lock module may claim/release
one private ownership file; its filesystem exception does not apply to either
local runtime mode. Hosted configuration/key/policy modules are currently being
tested independently and are not connected to production startup yet. Preserve
both old runtime guards and their positive denial controls. Provider resources,
real credentials, spending, merge and deployment remain separate owner decisions.
