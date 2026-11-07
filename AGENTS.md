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
  requires a build and separately running fixture server. No plan data in output.
- `npm run check:pr -- --event <path>`: validate a PR event with full Git history;
  requires trusted `JIRA_BASE_URL` in the environment. See README for offline fixtures.

Runtime dependencies: server/client SDK 2.4.0, Node adapter 2.1.2 and Zod 4.6.7;
tooling: TypeScript 7.0.2, Node types 26.6.6, Biome 2.6.6. See README for settings.
Both LOCAL_FIXTURE_MODE=true and DATA_MODE=fixtures are mandatory. Bind literally
127.0.0.1; production/live configuration and a nonempty YNAB_ACCESS_TOKEN fail.
Missing/empty allowlist denies all plans. Never expose this unauthenticated fixture
server through a proxy, tunnel or hosting service. No deployment command exists.
The single tool is read-only; test legacy initialize and modern discovery over
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
