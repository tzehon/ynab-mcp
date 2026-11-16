# MCP Tools for YNAB

A read-only MCP server that connects Codex, ChatGPT and Claude to your selected
YNAB plans. Sign in through YNAB OAuth; the server keeps YNAB credentials private
and issues separate MCP credentials bound to the owner.

Spending answers and charts come from reconciled transactions and categories.
Native client visuals use the same validated facts; the MCP view and private
Claude Code browser preview provide fallbacks. Incomplete or inconsistent evidence
fails instead of producing a partial spending answer.

## Connect a client

The shared **MCP Tools for YNAB** plugin is the preferred Codex/ChatGPT route.
For a configured service, connect through the client, authorize with YNAB and
select the plans it may read. Cloning this repository does not connect a client.

- [Hosting and authorization](docs/hosting.md): operator setup and release boundaries.
- [Claude clients](docs/claude-clients.md): web, Desktop and Code configuration.
- [Charts and previews](docs/spending-view.md): native views, metadata refresh and
  the terminal preview fallback.

Client capabilities differ. Jira and private release evidence record what was
actually tested; a successful tool call alone does not prove visible charts.

## Tools

| Tool | Purpose |
| --- | --- |
| `ynab_list_plans` | List owner-selected plans |
| `ynab_list_accounts` | Read accounts and balances |
| `ynab_get_month` | Inspect raw budget activity; **not a spending total** |
| `ynab_list_categories` | Read category metadata |
| `ynab_list_transactions` | Page through transactions with nested splits |
| `ynab_get_spending_report` | Inspect one month's reconciled spending and evidence |
| `ynab_get_spending_analysis` | Answer spending questions and chart 1–6 explicit months |

For spending questions, use the analysis tool. Do not sum raw activity or rebuild
its financial calculations in the client. See [analysis](docs/spending-analysis.md)
and [live tools](docs/live-tools.md) for arguments, bounds and failure behavior.

## Local development

Use Node **26.13.0** and npm **11.20.0**, pinned in `.node-version` and `package.json`.

```sh
git clone https://github.com/tzehon/ynab-mcp.git
cd ynab-mcp
npm ci --ignore-scripts
npm run check
npm run smoke:auth-fixtures -- --mode start
```

The smoke harness creates disposable synthetic authentication, exercises all seven
tools locally and cleans up. It requires no live service credentials and proves
no actual client connection. Never expose either local test mode through a proxy,
tunnel or hosting service. `.env` is not loaded automatically.

Use [local development](docs/local-development.md) for manual fixture setup,
integrated mocks, protocol/runtime limits and further checks. Docker-compatible
container tooling is required for `npm run check:container`.

## Contribute and operate

Read [AGENTS.md](AGENTS.md) for agent authority, privacy and delivery rules, and
[contributing](docs/contributing.md) for another-machine setup and PR metadata.
Changes go through Jira-linked, reviewed PRs and rebase merges; never push main.

| Reference | Covers |
| --- | --- |
| [Runtime contracts](docs/development-contracts.md) | Required spending, authentication and I/O safeguards |
| [Spending reports](docs/spending.md) | Reconciliation and source evidence |
| [Recovery](docs/recovery.md) | Private state, keys and recovery |
| [Service information](docs/public-service/README.md) / [Privacy](docs/public-service/PRIVACY.md) | Public service and data handling |
| [Research guide](https://github.com/tzehon/research/tree/main/ynab-mcp-sdlc-guide) | Private walkthrough and PROGRESS.md; repository access required |

Keep real financial data, credentials and configuration in protected private
storage/1Password, never Git or logs. The existing deployment uses free credits
only; paid resources require specific authorization.

See the [archived autofix demonstration and repeatable command](docs/demos/autofix-2026-11-16/README.md) for the original failure → repair sequence and how to run a fresh example.
