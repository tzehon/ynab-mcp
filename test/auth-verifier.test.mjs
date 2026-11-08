import test from "node:test";
import assert from "node:assert/strict";
import { Authenticator } from "../dist/auth/verifier.js";
import { fixtureTransport } from "../dist/auth/contracts.js";
import { parseConfig } from "../dist/config.js";
import { fixtureEnv, bundle, sign, pair, owner } from "./helpers/auth.mjs";
import { generateKeyPair, SignJWT } from "jose";

const config = parseConfig(fixtureEnv).auth,
  url = config.audience;
const now = Math.floor(Date.now() / 1000);
function authenticator(t) {
  const a = new Authenticator(config, fixtureTransport(bundle));
  t.after(() => a.close());
  return a;
}
test("real RS256 access tokens accept both types, audience arrays and exact scope", async (t) => {
  const a = authenticator(t);
  for (const typ of ["at+jwt", "application/at+jwt"])
    await a.authenticate(
      `bEaReR ${await sign(url, { aud: ["https://other.example.test/", url], scope: "openid ynab:read" }, { typ })}`,
      new AbortController().signal,
    );
});
const cases = [
  ["issuer", { iss: "https://issuer.example.test" }],
  ["audience", { aud: `${url}/` }],
  ["client audience", { aud: "synthetic-client" }],
  ["empty aud", { aud: [] }],
  ["mixed aud", { aud: [url, 1] }],
  ["expired", { exp: now }],
  ["future iat", { iat: now + 100 }],
  ["future nbf", { nbf: now + 100 }],
  ["string expiry", { exp: "9999999999" }],
  ["fractional expiry", { exp: now + 100.5 }],
  ["negative iat", { iat: -1 }],
  ["expiry before issue", { exp: now + 50, iat: now + 60 }],
  ["missing exp", { exp: undefined }],
  ["missing issuer", { iss: undefined }],
  ["missing subject", { sub: undefined }],
  ["missing client", { client_id: undefined }],
  ["missing jti", { jti: undefined }],
  ["empty jti", { jti: " " }],
  ["long client", { client_id: "x".repeat(257) }],
  ["scope type", { scope: ["ynab:read"] }],
  ["scope newline", { scope: "ynab:read\n" }],
  ["scope oversize", { scope: "ynab:read ".repeat(200) }],
];
for (const [name, claims] of cases)
  test(`reject token ${name}`, async (t) => {
    await assert.rejects(
      authenticator(t).authenticate(
        `Bearer ${await sign(url, claims)}`,
        new AbortController().signal,
      ),
      (e) => e.kind === "invalid",
    );
  });
for (const [name, header] of [
  ["ID JWT", { typ: "JWT" }],
  ["missing type", { typ: undefined }],
  ["missing kid", { kid: undefined }],
  ["unknown kid", { kid: "unknown" }],
  ["jku", { jku: "https://evil.test/keys" }],
  ["embedded jwk", { jwk: {} }],
  ["x5u", { x5u: "https://evil.test/" }],
  ["x5c", { x5c: [] }],
])
  test(`reject header ${name}`, async (t) => {
    await assert.rejects(
      authenticator(t).authenticate(
        `Bearer ${await sign(url, {}, header)}`,
        new AbortController().signal,
      ),
      (e) => e.kind === "invalid",
    );
  });
test("wrong owner is forbidden before missing scope; no scope/permissions substitution", async (t) => {
  const a = authenticator(t);
  for (const claims of [{ sub: "other", scope: "" }, { sub: "app@clients" }])
    await assert.rejects(
      a.authenticate(
        `Bearer ${await sign(url, claims)}`,
        new AbortController().signal,
      ),
      (e) => e.kind === "owner",
    );
  for (const scope of [undefined, "", "ynab:read_extra", "notynab:read"])
    await assert.rejects(
      a.authenticate(
        `Bearer ${await sign(url, { scope, permissions: ["ynab:read"] })}`,
        new AbortController().signal,
      ),
      (e) => e.kind === "scope",
    );
});
test("bad signatures and malformed authorization do not grant access", async (t) => {
  const a = authenticator(t),
    other = await generateKeyPair("RS256");
  await assert.rejects(
    a.authenticate(
      `Bearer ${await sign(url, {}, {}, other.privateKey)}`,
      new AbortController().signal,
    ),
    (e) => e.kind === "invalid",
  );
  const token = await sign(url);
  for (const header of [
    "",
    `Basic ${token}`,
    `Bearer ${token}, Bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} extra`,
    `Bearer ${"x".repeat(8193)}.a.a`,
  ])
    await assert.rejects(
      a.authenticate(header, new AbortController().signal),
      (e) => e.kind === "invalid",
    );
  await assert.rejects(
    a.authenticate(undefined, new AbortController().signal),
    (e) => e.kind === "missing",
  );
});
test("exact time edges are rechecked on cache hits", async (t) => {
  let time = now;
  const a = new Authenticator(
    config,
    fixtureTransport(bundle),
    undefined,
    () => new Date(time * 1000),
  );
  t.after(() => a.close());
  const token = await sign(
    url,
    { iat: now, exp: now + 20, nbf: now, sub: owner },
    {},
    pair.privateKey,
  );
  await a.authenticate(`Bearer ${token}`, new AbortController().signal);
  time = now + 20;
  await assert.rejects(
    a.authenticate(`Bearer ${token}`, new AbortController().signal),
    (e) => e.kind === "invalid",
  );
});

test("symmetric, unsigned and changed-signature tokens cannot substitute for RS256", async (t) => {
  const a = authenticator(t);
  const symmetric = await new SignJWT({ iss: config.issuer, aud: url })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid: "synthetic-key" })
    .sign(new Uint8Array(32).fill(1));
  const valid = await sign(url),
    parts = valid.split(".");
  const unsigned =
    Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString(
      "base64url",
    ) +
    "." +
    parts[1] +
    ".";
  for (const token of [
    symmetric,
    unsigned,
    `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`,
  ])
    await assert.rejects(
      a.authenticate(`Bearer ${token}`, new AbortController().signal),
      (e) => e.kind === "invalid",
    );
});
