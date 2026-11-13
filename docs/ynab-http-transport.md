# Injected read-only HTTP transport

`createHttpTransport` in `src/ynab/http-transport.ts` adapts an explicitly supplied
fetcher to the existing client. It is currently exercised only with synthetic
credentials and local HTTP servers. No application entrypoint imports it, and
all existing runtime tools still serve fixtures.

Construction requires a mapped-plan UUID allowlist, an asynchronous access-token
supplier and a fetch-compatible function. There are no environment defaults,
destination overrides or implicit token reads. The copied allowlist is checked
before credential or network work. The accepted requests are the existing
accounts, month, categories and date-bounded transactions GET descriptors at the
fixed YNAB origin. Requests are snapshotted before asynchronous work.

The caller must invoke the transport inside `CallLimits` and supply its signal.
That caller owns four-call admission and the single three-second deadline,
including token acquisition and body transfer. The transport has no separate
queue, timer, token cache, refresh or retry. It uses manual redirects and omits
cookies; a redirect never results in a follow-up request.

The adapter owns the network response until it has collected at most 1 MiB of
actual JSON bytes, or initiated disposal of a non-200 body without reading it.
It returns buffered bytes to the existing strict decoder, schemas and projections;
the existing 64 KiB output limit remains in effect. Empty chunks are not retained,
and periodic event-loop yields let caller cancellation run on ready streams.
Provider headers, error bodies, URLs and exception causes are not exposed.

Abort releases the transport's promise, listeners and reader lock, aborts its
fetch signal and initiates cancellation. Cleanup errors do not replace the
primary error, and hanging cleanup is not awaited. Late responses are discarded.
JavaScript cannot forcibly stop an arbitrary injected callback; the injection
seam is trusted. Tests separately prove that native fetch closes actual stalled
loopback requests. Test instrumentation is not a malicious-dependency sandbox.

Run from the pinned toolchain after `npm ci --ignore-scripts`:

```sh
npm run build
node --test test/ynab-http-transport.test.mjs test/ynab-http-integration.test.mjs
npm run check
```

The integration helper remaps only the validated logical origin to one exact
ephemeral `127.0.0.1` server. A second loopback server detects accidental redirect
following. Socket/DNS controls reject external destinations. All credentials and
responses are invented; no environment or vault secrets are used. Deadline tests
allow scheduling tolerance without changing the production three-second limit.

Live integration still needs OAuth grant wiring, refresh/revocation coordination,
real plan discovery and allowlisting, live output labels, hosted qualification
and actual Codex/ChatGPT verification. This module does not enable those paths.
