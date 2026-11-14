# Claude remote connector

The service supports an optional, separately registered confidential Claude client.
A deployed implementation and a discovered URL are not proof of actual client
acceptance. Track web, Desktop and Code separately in Jira and private release
evidence. Keep unsupported or untested combinations explicitly pending.

## Operator preparation

1. Preserve the existing owner, keys, encrypted store, plan selection and OpenAI
   client configuration. Add `OAUTH_CLAUDE_CLIENT_ID` and `OAUTH_CLAUDE_SECRET`
   together; neither is enabled by default. Use a distinct 8–128 character ID
   containing only letters, digits, `_` or `-`, and a separately generated random
   secret (at least 256 bits; 32–4096 printable characters). Save privately in
   1Password and the protected release record, never Git or command output.
2. This client has exactly one redirect URI:
   `https://claude.ai/api/mcp/auth_callback`. Authentication is
   `client_secret_post`. No callback override, DCR or CIMD is enabled. It requires
   S256, the exact MCP resource and existing read/continued-access scopes.
3. Release through the existing reviewed/deployed-source process, preserving all
   unrelated settings and the free-credit hosting limit. Confirm the old clients
   still work before onboarding Claude. Removing the optional settings disables
   new Claude authorization; do not equate configuration removal with revoking
   already issued credentials. Use the documented connection/revocation controls
   with their stated scope when revocation is required.

## Connect and verify each client

In Claude Customize → Connectors, add a custom connector with the service's `/mcp`
URL. Select **Sign in now** and **Use your own OAuth client**, enter the new client
ID and secret through the approved private handling procedure, and add/connect.
Complete the owner's YNAB consent. Do not add fixed authorization headers or use
another client's secret to work around an OAuth failure.

Claude web and Desktop use the account's remote connector. For Claude Code,
sign in to the same claude.ai subscription using normal `claude auth login`;
API-key/provider logins are not evidence of account-connector reuse. Inspect
`/mcp` and `/status` and verify the connector source. Avoid a duplicate direct
local MCP registration: it can take precedence over the account connector.

For **each** client, record:

- Authentication/connector identity and seven discovered read-only tools.
- A selected-plan read and one explicit unselected-plan denial, with no retries
  through a different client or expanded selection.
- A natural spending request that invokes `ynab_get_spending_analysis` with an
  explicit one-to-six-month range. Compare actual displayed values against the
  returned complete reconciled report and private independent source evidence.
- Returned canonical answer/chart identity and the client's rendering ability.
  If it cannot display SVG, disclose that limit; do not invent replacement facts.
- Tool unavailability after connector disconnect and restored access after
  reconnect, using fresh client state. Client-side removal alone does not prove
  server-side token revocation. Account-wide connector changes may affect all
  three Claude surfaces; preserve and verify the separate OpenAI connection.

Keep actual identifiers, spending, tokens and transcripts outside Git/Jira/logs.
Budget live calls: six-month analysis performs up to 30 upstream GETs. Reuse private
comparison evidence appropriately and avoid repeated requests merely to check UI.

References: [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
and [Claude Code account connectors](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claudeai).
