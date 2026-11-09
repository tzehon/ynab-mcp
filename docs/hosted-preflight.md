# Hosted authorization evidence

YNAB-6 implements hosted authorization while all tools remain fixtures. Jira owns
requirements and approvals. This document records reproducible evidence; it does
not authorize release or replace acceptance decisions in the PR.

## Local checks on 9 November 2026

The Dockerfile pins `node:26.13.0-bookworm-slim` to the official multi-platform index
`sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`.
Linux amd64/arm64 entries exist. OrbStack runs the arm64 image and reports
Node 26.13.0/npm 11.20.0. CI independently exercises the same container script.

The implementation uses the original pinned dependencies. The production entry
point selects a separate hosted factory with fixed provider destinations. Tests
use that factory behind a real TLS-to-HTTP proxy and a synthetic provider served
over verified local TLS; no runtime environment can select those test endpoints.
The harness owns all test certificates and invented identities. No real YNAB
account, provider configuration, budget request or deployment is exercised.

| Evidence | Checks |
| --- | --- |
| `test/hosted-config.test.mjs` | Explicit mode gates, secret/key validation, independent key material, retirement bounds, ownership claim and symlinks |
| `test/hosted-boundary.test.mjs` | Host/duplicate/target rules, stripped forwarding authority, bounded global admission, two fixed provider destinations and no budget dispatch, parser/redirect limits |
| `test/oauth-hosted-provider.test.mjs` | Real pinned engine, consent before scope filtering, optional offline access, rotating families, authenticated client binding, failure/race recovery, old consumed-member retention, idle/absolute bounds |
| `test/oauth-enrollment.test.mjs` | One-use capability, persisted attempts/confirmation, closed enrollment after disconnect, upstream single-flight and ambiguous refresh recovery |
| `test/hosted-acceptance.test.mjs` | Full enrollment HTTP/private confirmation, wrong owner, exact client methods, consent denial/CSRF, raw HTTP authority, incomplete delivery crash recovery, capacity failure, concurrent tabs and replay revocation |
| `test/hosted-smoke.test.mjs` | Production factories, local TLS proxy/provider, native and both confidential methods, two SDK eras, all five fixture tools, disallowed plan and disconnect denial |
| `test/hosted-runtime-audit.test.mjs` | Hosted storage/socket allowlist plus positive denial controls for filesystem, native SQLite/ATTACH, native sockets/DNS/HTTPS and subprocesses |
| Existing local suites | Both prior modes retain their separate guards and protocol/tool contracts |
| `npm run check:container` | Image build, UID 1000, private directories/socket, bootstrap denial, competing process, graceful restart, crash refusal, bounded offline claim recovery, symlink refusal, excluded image canary and secret-log negatives |

The complete refresh operation is guarded independently of adapter.consume:
validate client/family, durably reserve, run provider work outside transactions,
withhold success until finalization, and mark delivery complete after the HTTP
response finishes. A crash/incomplete delivery leaves authority unusable and
startup revokes it. Old consumed tokens remain encrypted until family expiry;
wrong-client/invalid-secret submissions cannot revoke another client's family.

## Remaining evidence and release boundary

The PR records tested SHAs, clean-clone/mutation results, CI and native Codex
code/security review. Do not treat this inventory as a passing claim for an
unexecuted subcheck. All fourteen criteria stay pending until their full evidence
is recorded. Only AC-1–AC-10 are local prerequisites. AC-11 requires separately
approved rebase delivery and traceability; AC-12–AC-14 require separately approved
hosted enrollment, actual clients and real lifecycle observations. No live budget
operation is authorized by this milestone.

[Hosting and machine resume](hosting.md) · [Recovery](recovery.md)

References: [pinned provider documentation](https://github.com/panva/node-oidc-provider/blob/v9.13.3/docs/README.md),
[official Node image source](https://github.com/nodejs/docker-node), and
[YNAB OAuth documentation](https://api.ynab.com/#oauth-applications).
