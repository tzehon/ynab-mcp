# Reconciled spending view

`ynab_get_spending_analysis` advertises the standard MCP Apps resource
`ui://spending/analysis-v1.html`. It remains one of seven tools, with the same
inputs, financial calculations, deadlines and text/structured result. Visual
hosts can display the original server-generated charts without asking a model to
recreate them. Non-UI clients retain the canonical text answer.

The static resource is authenticated, contains no plan data and is capped at
65,536 UTF-8 bytes. It uses no external assets, network requests, storage or extra
permissions. Only its parent host can initialize and deliver a result. New inputs,
errors, cancellation and teardown clear previous amounts; asynchronous validation
cannot restore a superseded result. The view checks the bounded schema, request
identity, period bounds, selected method, evidence digest and byte-exact shared
presentation before displaying the **original** SVG in an image context. This is
formatting verification of existing facts, not a second spending calculation.
The digest detects correspondence errors; it does not authenticate arbitrary data.
The existing MCP authorization boundary supplies trust.

Use the Monthly spending, Categories and Month comparison buttons. At narrow
widths, focus the chart region and scroll horizontally; scroll vertically for long
category lists. Open **Exact chart values and full labels** for an accessible
text table of every returned row, including long or wide-script names. These are
formatted existing facts, not recalculated totals. Labels and values are not shrunk to fit. The canonical answer and
retrieval time remain visible below. If validation fails, there is no financial
chart; request a fresh analysis rather than reconstructing values.

## Native client presentation

Prefer the client's native visualization/artifact capability when available.
The server is the source of financial facts; the client controls presentation.
Native views may use their own layout, theme and interaction, binding directly to
`months`, `categories` and `comparison.category_changes` from one successful,
complete `ynab_get_spending_analysis` result. Never recompute spending, deltas or
percentages from raw data. Preserve signed integer milliunits before formatting,
full labels, all requested rows, currency, dates, credits and provisional notices.
Retain `as_of` and `evidence_digest` for correspondence. Do not mix captures or
silently invent an Other bucket. A digest is not proof that a model copied facts
correctly: actual native views still require figure and readability checks.

For Codex use its native visualization capability; for Claude web/Desktop use
private artifacts when supported. Do not publish financial artifacts or add
external uploads. Claude Code terminal capability is separate: a browser preview
is a fallback and is not an inline terminal chart. If no supported native view is
available, use the authenticated MCP view/original SVG/private exporter below or
state the limitation with the canonical answer. Failed or partial analysis never
qualifies for a financial chart, regardless of renderer.

## Client setup and acceptance

Refresh the existing shared OpenAI plugin's tool metadata after deployment and
use a fresh conversation. Preserve the shared Codex/ChatGPT route, without adding
a duplicate native server. Claude uses its existing account connector; refresh
its catalog if needed. MCP Apps compatibility alone is not proof of display:
record actual web/Desktop behavior for each client. The implementation must not
be described as universally rendered until those checks pass.

## Claude Code terminal preview

The qualified terminal is Claude Code 2.1.232. It does not display this HTML view
inline. Use the actual tool-result capture to create a private browser preview.
The exporter does not run Claude, use an API key or make a provider call. A capture
may be older than the current budget; its timestamp is shown explicitly.

For a new capture, use your existing subscription and connector, ask for a selected
plan and an explicit reconciled analysis, and save official `--output-format
stream-json --verbose` output under `umask 077`. Do not paste values or credentials
into a command or enable shell tracing. Preserve the full native tool results:
the exporter requires a successful selected-plan listing followed by exactly one
successful matching analysis. Assistant prose is ignored. Multiple successful
analyses are ambiguous and refused; capture one requested report at a time.
Subscription limits still apply. Do not switch to a paid API to bypass them.

From the built checkout (`npm run build`):

```sh
npm run preview:spending -- /absolute/private/capture.jsonl /absolute/private/new-preview
```

The input must be an owner-owned regular 0600 file, at most 16 MiB, with no symlink
in its path. Use canonical absolute paths (`/private/tmp`, not its `/tmp` alias).
The output parent must already exist. The exporter creates a new 0700 directory
containing 0600 `index.html` and `analysis.json`, refusing existing destinations.
Open `index.html` directly in your browser. Keep both capture and preview outside
Git, Jira and shared folders. Do not upload or serve them publicly. If browser
automation cannot open local file URLs, open the file yourself; do not expose the
financial preview through a tunnel or other workaround.

If Claude web/Desktop reconnect but Code still has no tools, run the documented
connector-specific login, keeping the same account/permissions:

```sh
claude mcp login "claude.ai MCP Tools for YNAB"
```

Confirm discovery and an actual read in a new session. A `Connected` CLI status
alone does not establish that a fresh model session received the tools.
