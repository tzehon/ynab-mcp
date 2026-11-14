# Hosted authorization and owner-selected tools

The original hosted authorization was delivered through PR #6. YNAB-8 adds
explicit live mode and owner-selected plans. Jira owns requirements, delegated
owner decisions and actual release evidence. The standing authorization permits
reviewed delivery and constrained release; required human sign-in/consent and
agreed spending limits remain. Fixture mode stays synthetic; live mode adds
fixed, bounded catalog and selected-plan GET requests.

## Modes and repeatable checks

`fixture-token` and `integrated-mock` retain their local-only restrictions.
`integrated-hosted` is an explicit production mode. Never publish either local
mode, a test harness, synthetic signing keys or a fixture provider.

On a new machine clone the repository, check out the approved branch/revision,
install Node 26.13.0/npm 11.20.0, then run:

```sh
npm ci --ignore-scripts
npm run check
npm run smoke:auth-fixtures -- --mode start
npm run smoke:auth-fixtures -- --mode dev
npm run smoke:auth-integrated -- --mode start
npm run smoke:auth-integrated -- --mode dev
npm run smoke:auth-hosted
npm run check:container
```

Start OrbStack before the container check on macOS. `orb status`,
`docker context show` and `docker info` distinguish a stopped engine from an
application failure. The container check builds locally and removes its own
containers, volume, temporary runtime keys and image. It never deploys or uses
real credentials. CI runs the same container check without provider secrets.

The Dockerfile pins the official Node image by digest and includes only compiled
application files, production dependencies, a bounded entrypoint and private
operator helpers. Build from a clean approved revision and supply its full SHA
as `SOURCE_REVISION`; do not supply runtime secrets as build arguments. Runtime
Node executes as UID/GID 1000. The initializer touches only the two exact private
directories and refuses symlinks. `/data` must be a dedicated volume.

## Private configuration register

Keep exact values and owner decisions in 1Password and the private release record.
Reuse the existing Railway service after inspecting its current state. The
service hostname must match the approved private register and YNAB application
requirements; preserve the existing reservation. The public application name is **MCP Tools for
YNAB**; the repository name is unchanged. Source remains disconnected and
autodeploy disabled. Let `H` be the exact approved
`https://<service>.up.railway.app` origin, without a trailing slash. Never infer it
from incoming headers. Update every issuer/resource/callback consistently.

| Setting | Required value or source |
| --- | --- |
| `AUTH_MODE` | `integrated-hosted` |
| `HOSTED_AUTHORIZATION_ENABLED` | `true` |
| `NODE_ENV` / `DATA_MODE` | `production` / `fixtures` during enrollment; `live` only after owner confirmation |
| `LIVE_YNAB_ENABLED` | `true` only with live mode; otherwise absent |
| `PORT` | Railway service port, positive integer |
| `AUTH_ISSUER` | `H` |
| `AUTH_AUDIENCE` / `MCP_PUBLIC_URL` | `H/mcp` |
| `OAUTH_STATE_DIR` | `/data/authorization` |
| `OAUTH_KEY_BUNDLE` | Private JSON bundle from separately approved preparation |
| `YNAB_CLIENT_ID` / `YNAB_CLIENT_SECRET` | Existing or separately approved YNAB OAuth registration |
| `OAUTH_NATIVE_CLIENT_ID` / `OAUTH_NATIVE_CALLBACK` | Static Codex client ID and observed literal-loopback callback |
| `OAUTH_WEB_CLIENT_ID` / `OAUTH_WEB_CALLBACK` | Static ChatGPT client ID and exact callback displayed by its setup UI |
| `OAUTH_WEB_AUTH_METHOD` / `OAUTH_WEB_SECRET` | Observed `client_secret_post` or `client_secret_basic`, and private client secret |
| `OAUTH_CLAUDE_CLIENT_ID` / `OAUTH_CLAUDE_SECRET` | Optional pair: distinct static Claude client and independent secret; fixed `https://claude.ai/api/mcp/auth_callback`, `client_secret_post`. Omit both to disable; partial/invalid/reused credentials fail startup |
| `FIXTURE_ALLOWED_PLAN_IDS` | Fixture mode only: explicit built-in IDs. Must be absent in live mode; encrypted owner selection controls real plans |
| `AUTH_ALLOWED_SUBJECT` | Verified YNAB UUID after enrollment; never infer from email |

The hosted service serves static GET/HEAD `H/` and `H/privacy` without a
credential, in both closed enrollment and normal mode. They use the same
canonical-host, readiness, admission and security-header checks as other hosted
routes, set no cookies, perform no provider requests and contain no runtime
identifiers. Queries/aliases and non-read methods are rejected. Local test modes
do not gain these routes. Enrollment, consent and connection pages link to the
policy. Verify its accuracy and public availability before registration; do not
infer current availability from a previous deployment. The shared hosted-page footer includes the
affiliation and trademark notice required by the [YNAB API terms](https://api.ynab.com/#terms).
Keep that notice aligned with the public registration pages when updating copy.

Register `H/connect/ynab/callback` with YNAB after approval. Use `H/` as the
website and `H/privacy` as the privacy URL, after checking both publicly. Request `read-only`.
Do not guess callbacks or enable dynamic registration if a client does not expose
static registration. Record that qualification as blocked and revise the design.
Do not set local/mock/PAT/debug/proxy/TLS-override environment variables.

Before real key preparation, get the separate credential decision. The operator
helper `node scripts/prepare-hosted-keys.mjs /absolute/private/path/keys.json`
writes a new 0600 file under an existing owner-only 0700 directory; it refuses
overwrite/symlinks and prints no key. Save the independent encryption, lookup,
cookie and signing material in 1Password, inject the bundle through Railway's
private runtime settings, then remove the temporary file according to the chosen
private handling procedure. Never put keys in the volume, command arguments or Git.
Local tests generate only disposable invented keys.

## Closed enrollment

With no owner setting, provide a privately generated 256-bit hex
`OAUTH_ENROLLMENT_CAPABILITY`, unique `OAUTH_ENROLLMENT_ID`, and absolute Unix
millisecond `OAUTH_ENROLLMENT_EXPIRES` at most fifteen minutes ahead. Configure
these only for the explicitly approved enrollment deployment. Normal OAuth/token
and MCP routes are disabled. Never put the capability into a URL.

The owner opens `H/enroll`, enters the capability in the form, and signs in on
YNAB. A one-use browser-bound flow calls the two approved control endpoints.
It discards upstream tokens and waits for separate operator confirmation. Five
failed capability attempts exhaust an issuance; restarting does not reset it.

In an authenticated private Railway terminal as UID 1000, the operator runs
`node scripts/authorization-admin.mjs status`, then `candidate`. Candidate output
is private: do not paste it into Jira, public logs or this repository. Confirm with
the owner that they used the intended account, then pass that exact UUID on stdin
to `node scripts/authorization-admin.mjs confirm`. The helper uses a 0600 Unix
socket in `/run/ynab-mcp` (0700); it has no public HTTP/TCP administrative endpoint.

Save the verified UUID as `AUTH_ALLOWED_SUBJECT`, remove all three enrollment
settings, and restart normal mode. Stale enrollment settings or a different UUID
fail startup. Confirmation is durable and removes the candidate. The bootstrap
browser still cannot use MCP. Complete a fresh normal authorization/consent flow.
Normal disconnect preserves the owner binding and cannot reopen enrollment.

## Normal use and release evidence

Each static client gets its own explicit consent and separate MCP credentials.
`offline_access` requests continued access with rotating MCP refresh tokens;
without it the client must reauthorize after access expiry. Refresh families have
a seven-day idle and thirty-day absolute bound. Replay revokes that client's
family, while local owner disconnect revokes every owner grant. YNAB tokens remain
server-side. Upstream refresh is independent; ambiguous failure requires reconnect.
In live mode, tools use the bounded budget transport and shared upstream refresh; fixture mode makes no budget requests. `/connection` provides protected
refresh/disconnect controls; disconnect does not revoke the provider's app grant.

Before deployment approve the exact delivered SHA/image, service/environment,
one-process/replica/volume topology, current plan/network eligibility and concrete
cost envelope/stop policy. The approved amendment selects preparation of a
credit-only Trial route, with a **2-vCPU ceiling**, at most **1 GiB RAM** and
**0.5 GB volume**. This replaces the earlier 1-vCPU proposal; it does not authorize
deployment or spending. Recheck actual allocated units and Trial eligibility.
One service/process/replica only; no serverless sleeping during lifecycle checks,
horizontal scaling or shared preview store. Expect volume-backed redeployment
downtime. Do not reconnect source to trigger an automatic build.

For the separate deployment decision, prepare this concrete stop procedure:

- Record starting usage, remaining credits and verified expiry privately. Resolve
  inconsistent date labels before starting. No paid upgrade, top-up or paid fallback.
- Propose at most US$1 additional Trial usage; stop at US$2 remaining credit,
  within 24 hours of verified expiry, after two attended hours, at session end,
  or on unexpected plan/usage changes, whichever happens first.
- Check usage at start, at most every 15 minutes and before stopping. Record the
  responsible operator and how they stop the active deployment; verify it is
  offline and cannot automatically restart. Keep compute stopped between sessions.
- Account for continuing volume charges. Usage reporting can lag, so manual
  observations are not a guaranteed monetary hard cap. No configurable Trial
  hard cap was established by preflight. Trial exhaustion/expiry is the provider
  fallback; reverify it and refuse any step that requires payment.

Keep live expiry/refresh evidence pending across attended sessions rather than
shortening upstream lifetimes. Persistent encrypted state permits later resume.
If the credit window cannot accommodate qualification, stop and record the gap;
never infer permission to upgrade. Private account amounts and identifiers belong
in 1Password, not this guide.

Qualification requires observed edge HTTPS/Host behavior, volume permissions,
public denial and platform-log canaries before any real consent; generic health
only confirms local readiness. Test actual Codex and ChatGPT separately with fresh
sign-in, all five tools in the intended data mode, allowlist denial, actual expiry/refresh, restart,
disconnect/reconnect and a fresh profile or second machine. SDK tests do not prove
those outcomes. Record deadlines privately and leave unobserved live criteria
pending. A merge leaves the issue Ready to release until all hosted criteria pass.
See [recovery](recovery.md) before release.

## Owner-selected live tools

After enrollment, follow [live setup](live-tools.md) to enable the explicit live mode and choose plans. Keep enrollment closed until reviewed code, public policy links, provider logging and private storage checks pass. Retain the existing cost-stop controls and recovery procedure.

## Claude connector

See [Claude setup and qualification](claude-clients.md). The optional client adds
no provider scope, dynamic registration or anonymous access. It shares the existing
owner and explicitly selected plans, while codes/refresh families remain bound to
their individual OAuth clients. Existing OpenAI credentials are not reused.
