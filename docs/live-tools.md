# Live owner tools

Live mode uses the existing integrated hosted OAuth service. Local fixture-token
and integrated-mock modes remain synthetic. The owner signs in to YNAB using the
existing login; the service issues separate MCP credentials to each client.

After private owner enrollment, set `DATA_MODE=live` and
`LIVE_YNAB_ENABLED=true` alongside the hosted production configuration. Remove
`FIXTURE_ALLOWED_PLAN_IDS`. Live startup requires the verified owner binding;
enrollment itself runs with fixture mode. Keys, OAuth credentials and exact
client callbacks belong in private runtime configuration, not this repository.

Connect the client using its registered profile. On the authenticated
`/connection` page, open **Choose plans**, select up to ten and save. The form
replaces the previous selection; leaving it empty denies all budget reads.
New YNAB plans never become available automatically. Refresh `ynab_list_plans`
in the client after saving. Changing the selection invalidates in-flight reads.

The five tools have the same financial projections as fixture mode. Live outputs
say `data_mode: live`, `source: ynab`, use real selected plan UUIDs, the selected
plan currency, and a retrieval timestamp. Accounts and month values use exact
integer milliunits. Category output is metadata only. Transactions exclude
pending items, preserve nested splits and permit a 1–90-day inclusive window
with up to 100 results. If truncated, narrow the date window; the service does
not guarantee complete history. Invalid or oversized responses fail safely.

The server stores only encrypted authorization and minimal selected-plan
metadata. It does not persist financial responses. Client conversations can
retain returned data; see the [privacy policy](public-service/PRIVACY.md).

Read requests have one process-wide four-call budget and one three-second total
deadline, including token refresh. A shared refresh already sent must settle
safely even if a reader cancels; cancellation prevents late budget dispatch.
The service checks the connection generation, selected-plan version and verified
client grant before returning data. Disconnect clears both client grants and
selection. Reconnect through OAuth and choose plans again. Revoke YNAB permission
separately in YNAB account settings when retiring access.

Synthetic hosted tests exercise both client profiles and both SDK protocol eras:

```sh
npm run check
npm run smoke:auth-hosted
```

These tests do not establish actual Codex or ChatGPT connectivity. Record each
actual-client result separately during release. Use the existing hosting and
recovery procedures, private release register and current credit-only stop limits.
