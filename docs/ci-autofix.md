# CI repair proposals

`Codex CI autofix` proposes small source/test repairs after `PR checks` fails.
It is **off by default**. It changes no running service and never merges or deploys.
It adapts the [official example](https://learn.chatgpt.com/docs/non-interactive-mode#example-autofix-ci-failures-in-github-actions)
to this repository's admission, patch validation and review requirements.

## What runs

1. A trusted main-branch controller admits only the current open owner-authored,
   same-repository issue branch targeting main. `bootstrap-tests` must fail while
   `pr-metadata` passes. Forks, stale/closed PRs, reruns, main failures and repair
   branches are excluded. A bot comment claims one attempt per source SHA; a
   no-patch/error attempt also consumes that claim. Global concurrency prevents
   overlapping claims. GitHub may replace queued pending runs, so repair is
   best-effort, not guaranteed for every failure.
2. A fresh runner checks out that exact SHA without stored Git credentials and
   installs dependencies with lifecycle scripts disabled. The pinned official
   Codex action uses `:workspace` and `drop-sudo`, with the API key supplied only
   through its protected action input. Codex has read-only repository permissions,
   no production/Jira secrets, no Docker access and no command network access.
   It starts with `npm run check` within ten minutes. If the protected environment
   blocks child-process pipes or loopback sockets, it may reproduce an application
   assertion using an existing targeted test in-process (`--test-isolation=none`).
   Assertions stay intact; it rebuilds and reruns the same test after the repair,
   retries the full check and reports remaining environment restrictions honestly.
   Full checks and the container gate must still pass independently before any PR.
   Container, metadata, dependency and infrastructure-only failures produce no patch.
3. Only a bounded text patch is retained for one day: at most 20 regular source
   TypeScript or `*.test.mjs` files and 100 KB. Configs, dependencies, workflows,
   instructions, deletions, binary files, symlinks and mode changes are rejected.
   An independent runner applies it to the exact source and runs full checks and
   the container gate with no model key or repository write token.
4. A separate publisher rechecks the original PR/head and validates the patch
   again. GitHub's Git-data API creates one issue-keyed branch and draft repair PR
   **targeting the original feature branch**. No candidate code runs with a write
   token. No main push, force-push, merge or deployment occurs. A racing source
   update can leave an obsolete draft; inspect its base before integration.

## Follow an attempt

The source PR receives an **Autofix started** bot comment linking its exact commit,
failing CI and **watch autofix** run. The run title names the source branch and
failed CI run number. Follow that run through `admit`, `generate`,
`validate`, `publish` and `report`.

The final **Autofix outcome** comment links the generated **Autofix for #N —
validated repair** draft, or reports no patch/failed stages honestly. The draft
links back to the source PR and both runs. A trusted reporting job has no model
key, contents write permission or candidate execution. It verifies the associated
bot-created draft before posting a success link and suppresses duplicate outcomes.
If the source becomes stale/closed, a job is forcibly stopped, or GitHub reporting
fails, an outcome may be absent; the original run link remains the place to inspect.

Showcase PRs can be deliberately retained for owner inspection. Label them clearly
as synthetic demonstrations that must never enter main. For disposable examples, close
the repair first, then the source PR, and delete their branches without merging.
For the permanent archived example, retain both branches and tags after closing;
see the [archived showcase and repeatable command](demos/autofix-2026-11-16/README.md).

The patch may still be wrong or weaken tests despite passing checks. Review it.
Original Jira links are retained, but all acceptance entries become pending;
the bot asserts no new approval or completed criteria. It cannot read Jira.
Revalidate the live issue, snapshot and scope under the normal delivery workflow.

## Activate after reviewed delivery

Activation requires the owner's API-spending decision and private credential
setup. API use is separate from a ChatGPT subscription. Do not copy desktop
`auth.json` into this public repository's CI.

1. Use a dedicated OpenAI project/key with the owner's chosen model and usage
   limits. Save the key in 1Password and the GitHub Actions secret
   `OPENAI_API_KEY`; never paste it into chat, prompts, source or workflow
   environment variables. Ordinary CI/build steps must not receive the key.
   Configure provider controls/monitoring for the agreed budget: the ten-minute
   timeout and one-attempt policy are **not a hard monetary cap**.
2. Set repository variable `CODEX_AUTOFIX_MODEL` to the approved available model.
3. In Actions settings, enable **Allow GitHub Actions to create and approve pull
   requests**. Keep default workflow permissions read-only. No workflow step
   approves a review or enables auto-merge; write access is job-scoped.
4. Set `CODEX_AUTOFIX_ENABLED=true`. Missing/false disables admission without a
   model call. To stop, set it to `false` and cancel active autofix runs; changing
   the variable alone does not terminate a job that already started.
5. Use an approved synthetic failing same-repository PR to verify admission,
   reproduction, generation, independent validation and draft publication. Verify
   a rerun/repeated SHA is skipped. Record actual usage and clean up test branches.
   Until this passes, end-to-end activation acceptance remains pending.

## Review and integrate

GitHub currently puts PR workflows created by `GITHUB_TOKEN` into an
[approval-required state](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
Select **Approve workflows to run** when offered. PR checks cover both main and
issue-branch targets, so repairs receive normal checks after approval.
Revalidate Jira scope and truthful evidence, complete final-head native Codex
code/security reviews, then rebase-merge the repair into its original feature
branch. Recheck the updated parent PR and reviews before normal rebase delivery
to main. Clean up repair branches after equivalence is verified. Native review
is not established by a bot creating a draft; request it explicitly if needed.

There is no automatic retry loop. A new source SHA can get a new attempt. For a
model/proxy/permission failure, inspect the run rather than delete claim comments
and repeatedly spend on the same failure. If ref creation succeeds but PR creation
fails, an unreferenced repair branch may remain; inspect it before cleanup.

## Local verification

Use pinned Node/npm, `node --test test/ci-autofix.test.mjs`, `npm run check` and
`actionlint .github/workflows/*.yml`. Tests use invented GitHub/Jira data and local
Git repositories. They do not prove API credentials, billing or hosted generation.

The metadata job explicitly fetches immutable event base/head commits before
validation. Post-merge edits after branch deletion no longer need an AI call or
temporary branch restoration.
