# ynab-mcp

A local, fixture-only MCP server and delivery checks for a future personal,
read-only YNAB service. The server returns invented data from one tool,
`ynab_list_plans`. It is not connected to YNAB, Codex or ChatGPT, and is not hosted.
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
each protocol era without dumping plans. It uses the official SDK client, tests
discovery/list/call and schema validation, rejects redirects and any noncanonical
loopback URL, and bounds each HTTP operation to 5 seconds and the run to 20 seconds.
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
annotations, and has no write or external-data adapter. Annotations describe the
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
The SDK's static warning about dropped notifications is expected; this tool emits
none. This interoperability evidence is not a real Codex/ChatGPT connection test.

Bodies are limited to 65,536 bytes (larger bodies return 413). Every connection
closes after its response and has a 10-second total deadline, including incomplete
headers/bodies. Shutdown closes sockets and resources within 5 seconds. Diagnostics
contain fixed codes and the listening port, not request bodies, headers or secrets.

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
repository Actions variable `JIRA_BASE_URL`. Missing configuration fails explicitly.
The origin is not a credential; do not place it in committed fixtures or print it.
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
- `acceptanceCriteria`: exactly one entry each for `AC-1` through `AC-8` for this
  current eight-AC contract. Each entry has `id`, a specific `check`, `status` and `evidence`.
  Status is `passed`, `failed` or `pending`; pending also requires `remaining`.
  Later issues with different AC sets require an explicit validator change.

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
