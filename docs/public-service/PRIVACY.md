# Privacy policy

Last updated: 13 November 2026. This policy covers MCP Tools for YNAB, a private, owner-operated service. It is not a public multi-user service.

## Information and purpose

The service verifies its owner and authorizes Codex and ChatGPT to use five read-only tools. It processes a YNAB account identifier, OAuth codes and access/refresh credentials, client permissions, short-lived setup records and browser session cookies. It does not collect your YNAB password.

In live mode it retrieves selected-plan accounts, month summaries, category metadata and bounded transactions on request. Financial responses are processed transiently and returned to the requesting client; they are not stored in the application database. Selected plan IDs, names and currencies are saved as encrypted metadata. Fixture mode returns invented data. No write tools are provided.

## Storage and sharing

Authorization records and selected-plan metadata are encrypted in persistent server storage. Encryption/signing material is kept separately in private runtime settings and 1Password. YNAB credentials remain on the server. Clients receive separate service credentials and tool results, which contain financial information in live mode. Your client may retain those results in conversation history under its own policies.

Railway hosts the service and terminates HTTPS, so it processes network traffic and hosts runtime data. YNAB processes sign-in, consent, token, identity and budget-read requests. OpenAI processes client interactions under its own policies. There is no application analytics or advertising. Application logs contain bounded operational metadata, not credentials or financial payloads. Hosting/client platforms may retain separate logs, under their own retention and deletion controls. The operator verifies platform logging before live sign-in.

## Retention

Authorization codes last up to one minute, interactions and plan-selection forms up to five minutes, normal browser sessions and service access tokens up to one hour. Continued-access grants expire after seven idle days or thirty days overall. Expired records become unusable; storage is reclaimed in bounded batches during later writes, not necessarily at expiry.

Selected-plan metadata remains until replacement or disconnect. Upstream credentials remain until disconnect or invalidation; usability follows YNAB's expiry/revocation rules. Owner binding and enrollment records persist to prevent unauthorized re-enrollment. Financial tool results are not persisted by this application; client conversation retention is separate.

## Disconnect and deletion

Use Disconnect on the authenticated connection page to invalidate both clients and remove usable locally stored grants, upstream credentials and selected-plan metadata. Owner binding remains. Disconnect does not revoke permission at YNAB; do that separately in YNAB account settings. Logical deletion does not promise immediate physical erasure from storage or provider logs.

For complete service-data removal, the owner/operator stops the service and prevents restarts, revokes YNAB access, removes client connections, then deletes dedicated authorization storage and controlled private copies/backups. Remove associated runtime secrets and private register copies when retiring the service. Follow the [operator deletion procedure](../recovery.md#complete-service-data-removal), including provider retention limits. There is no public deletion form. This service cannot delete client conversations or platform logs. Reuse after erasure requires fresh private enrollment and consent.

We are not affiliated, associated, or in any way officially connected with YNAB or any of its subsidiaries or affiliates. The official YNAB website can be found at [https://www.ynab.com](https://www.ynab.com).

The names YNAB and You Need A Budget, as well as related names, tradenames, marks, trademarks, emblems, and images are registered trademarks of YNAB.
