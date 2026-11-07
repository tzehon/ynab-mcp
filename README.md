# ynab-mcp

Delivery foundations for a future personal, read-only YNAB MCP service for Codex
and ChatGPT, hosted on Railway. This repository currently contains a PR metadata
validator and workflow documentation. No MCP server is implemented or deployed.

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
  bootstrap contract. Each entry has `id`, a specific `check`, `status` and `evidence`.
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
Actions. The metadata job reports the event and head SHA; superseded runs cancel.
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
   decision and keep the issue key in the final squash title. Never push main.
5. After merge, verify the delivered commit and merged PR appear in Jira and link
   back correctly. Record the delivered SHA and final evidence for every AC.
   Only then move this setup issue through Ready to release to Done.

The guided setup and checkpoint register live in
[the research guide](https://github.com/tzehon/research/tree/main/ynab-mcp-sdlc-guide).
Current specifications and approval snapshots remain in Jira.
