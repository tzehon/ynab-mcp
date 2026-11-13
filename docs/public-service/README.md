# MCP Tools for YNAB

A private, owner-operated connection from Codex and ChatGPT to five read-only YNAB tools: selected plans, accounts, category metadata, a month summary, and a bounded transaction window. This is not a public multi-user service.

Connect from your configured client, approve its access, then sign in and authorize this service on YNAB's website using your existing YNAB login. No separate Auth0 or Google account setup is needed. Your client receives credentials for this service; YNAB OAuth credentials stay on the server. Only the privately enrolled owner can connect.

In live mode, visit the authenticated connection page to select up to ten plans. Only selected plans are available to tools. Empty selection disables budget reads. Fixture mode returns clearly labeled invented data. Financial amounts are exact integer milliunits; divide by 1,000 for currency units. Transaction queries cover at most 90 days and return at most 100 records. Results may be truncated; narrow the date window. No write tools or complete-history guarantee are provided.

Read the [privacy policy](PRIVACY.md) before connecting. Disconnect removes both clients' usable local grants and selected-plan metadata. Revoke the service separately in YNAB account settings to remove its YNAB permission.

We are not affiliated, associated, or in any way officially connected with YNAB or any of its subsidiaries or affiliates. The official YNAB website can be found at [https://www.ynab.com](https://www.ynab.com).

The names YNAB and You Need A Budget, as well as related names, tradenames, marks, trademarks, emblems, and images are registered trademarks of YNAB.
