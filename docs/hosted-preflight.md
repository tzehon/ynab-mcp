# Hosted authorization preflight evidence

YNAB-6 is in progress. Jira owns the approved requirements and implementation
plan; this file records observations, not a replacement specification.

On 9 November 2026 the official Docker registry resolved
`node:26.13.0-bookworm-slim` to the multi-platform index
`sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`.
Linux amd64 and arm64 entries exist. This is registry evidence, not a successful
image build. The local Docker endpoint is unavailable; image runtime/npm and
container acceptance remain unverified and mandatory before merge.

`test/oauth-hosted-provider.test.mjs` exercises the pinned engine over verified
local TLS with disposable keys and the encrypted SQLite adapter. Its explicit
test-only interaction handler simulates a person consenting; it does not contact
YNAB or establish actual client compatibility. Production startup does not import
the harness or enable hosted mode yet.

The supported `findAccount` hook observes the engine's validated client and token
source before refresh consumption. A durable family reservation precedes engine
writes. Outer provider middleware finalizes before releasing the response.
Probes cover both client profiles, OAuth-only offline access with consent forced
before scope filtering, no-offline behavior, cross-client rejection, successor
save/finalization failure, concurrent reuse, disconnect during finalization,
startup invalidation of unfinished reservations, and idle/absolute bounds.

These probes establish a starting integration, not all AC-5 evidence. Old
consumed-member retention after its token expiry, final production routing,
upstream control refresh, capacity failure and full recovery remain to implement
and test. All fourteen ACs remain pending in the draft PR until their complete
evidence is recorded. No release, provider resource, real credential or live
budget operation was performed.

References: [pinned provider documentation](https://github.com/panva/node-oidc-provider/blob/v9.13.3/docs/README.md),
[official Node image source](https://github.com/nodejs/docker-node), and
[YNAB OAuth documentation](https://api.ynab.com/#oauth-applications).
