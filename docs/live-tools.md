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

The six tools have the same financial projections as fixture mode. Live outputs
say `data_mode: live`, `source: ynab`, use real selected plan UUIDs, the selected
plan currency, and a retrieval timestamp. Accounts and month values use exact
integer milliunits. Category output is metadata only. Transactions exclude
pending items, preserve nested splits and permit a 1–90-day inclusive window
with up to 100 results per page. Follow `next_cursor` using the exact same plan
and date window until it is null. A stale cursor requires restarting that window;
do not combine pages from different source versions. Raw input is still bounded
at 1,000 transactions / 1 MiB per response, so complete history is not guaranteed.
Invalid or oversized responses fail safely.

Use `ynab_get_spending_report` for spending, once per requested calendar month.
Raw `ynab_get_month.activity_milliunits` includes payment bookkeeping and is
explicitly marked `activity_is_spending: false`. See [spending semantics and
verification](spending.md).

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
