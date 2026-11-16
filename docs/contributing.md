# Contributing and delivery

Follow [AGENTS.md](../AGENTS.md) for authority, required reviews and delivery
gates. Jira owns approved requirements; the private research guide tracks progress.

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

6. Read `AGENTS.md`, the current Jira fields and approval comments, including
   explicitly identified delegated decisions. Revalidate
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

Fill out [the PR template](../.github/pull_request_template.md). Keep exactly one fenced
`ynab-metadata` JSON block, schema version 1, with:

- `issueUrl`: exact configured HTTPS origin and `/browse/YNAB-<number>` matching
  the single primary key in the title `YNAB-<positive integer>: <summary>`.
- `approvals.spec`, `.ac` and `.plan`: each has `revision`, `snapshotUrl` and
  `decisionUrl`. Use same-site attachment URLs and decision links to the same
  issue with `?focusedCommentId=<comment-id>`. Replace all placeholders.
- `acceptanceCriteria`: exactly one entry per required AC, with `id`, a specific
  `check`, `status` and `evidence`; pending entries also need `remaining`.
  The [validator](../scripts/lib/pr-metadata.mjs) defines the issue-specific
  counts (eight by default). Check its current mapping before preparing metadata;
  a different approved AC set requires an explicit reviewed validator change.

Malformed data, failed ACs, missing commit keys or missing trusted configuration
exit 1. Pending evidence is accepted for work in review, printed separately, and
**never counts as a pass or completion**. All ACs must pass before Done.

These checks validate syntax, not Jira existence, approval authorship, evidence
truthfulness or equality with current Jira fields. The agent must independently perform
the authenticated checks; CI does not authenticate Jira decisions. No Jira or YNAB API credentials enter CI. The separately enabled
[CI repair workflow](ci-autofix.md) uses an OpenAI key only in its isolated,
protected Codex action; ordinary PR checks have no OpenAI key.

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
reopened and edited events against main and issue branches, with read-only permissions and pinned
Actions. A push to main runs application checks; PR metadata is skipped for that
event. The metadata job reports the event and head SHA; superseded runs cancel.
Require these exact job names in main's ruleset after their first successful run.
A PR can change its own checker/workflow, so passing CI is not independent proof
that the checks remained intact. Review those diffs explicitly.

Before merging, follow the final-head review, recorded delegated decision,
rebase equivalence, main CI, Jira navigation and branch-cleanup requirements in
[AGENTS.md](../AGENTS.md). A personal approval wait is not required for work
covered by the owner's standing authorization. Record decisions truthfully as
delegated. Deployment remains a separate recorded decision after preflight.

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
