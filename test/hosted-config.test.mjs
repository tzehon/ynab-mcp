import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { hostedConfig } from "../dist/oauth/hosted-config.js";
import { hostedKeys } from "../dist/oauth/hosted-keys.js";
import { claimProcess } from "../dist/oauth/process-lock.js";

const hex = () => randomBytes(32).toString("hex");
const env = () => ({
  AUTH_MODE: "integrated-hosted",
  HOSTED_AUTHORIZATION_ENABLED: "true",
  NODE_ENV: "production",
  DATA_MODE: "fixtures",
  PORT: "3000",
  AUTH_ISSUER: "https://fixture-host.up.railway.app",
  AUTH_AUDIENCE: "https://fixture-host.up.railway.app/mcp",
  MCP_PUBLIC_URL: "https://fixture-host.up.railway.app/mcp",
  OAUTH_STATE_DIR: "/data/authorization",
  OAUTH_KEY_BUNDLE: "not-parsed-until-key-boundary",
  OAUTH_NATIVE_CLIENT_ID: "fixture-native",
  OAUTH_WEB_CLIENT_ID: "fixture-web",
  OAUTH_NATIVE_CALLBACK: "http://127.0.0.1:9876/callback",
  OAUTH_WEB_CALLBACK: "https://client.example/callback",
  OAUTH_WEB_AUTH_METHOD: "client_secret_post",
  OAUTH_WEB_SECRET: hex(),
  YNAB_CLIENT_ID: "fixture-upstream",
  YNAB_CLIENT_SECRET: hex(),
  AUTH_ALLOWED_SUBJECT: "11111111-1111-4111-8111-111111111111",
});

test("hosted contracts require explicit production opt-in and reject local/live escapes", () => {
  assert.equal(hostedConfig(env()).mode, "integrated-hosted");
  for (const [k, v] of Object.entries({
    HOSTED_AUTHORIZATION_ENABLED: "false",
    NODE_ENV: "test",
    DATA_MODE: "live",
    LOCAL_FIXTURE_MODE: "true",
    HOST: "127.0.0.1",
    PORT: "0",
    AUTH_ISSUER: "https://evil.example",
    AUTH_AUDIENCE: "https://evil.example/mcp",
    OAUTH_STATE_DIR: "/tmp/store",
    OAUTH_WEB_AUTH_METHOD: "none",
    OAUTH_WEB_CLIENT_ID: "fixture-native",
    OAUTH_NATIVE_CALLBACK: "http://localhost:9876/callback",
    OAUTH_WEB_CALLBACK: "https://client.example/callback?x=1",
    YNAB_CLIENT_SECRET: "synthetic-secret",
    AUTH_ALLOWED_SUBJECT: "owner@example.com",
    HTTPS_PROXY: "https://proxy.example",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    OAUTH_KEY_FILE: "/tmp/keys",
    DEBUG: "1",
    MOCK_YNAB_ORIGIN: "http://127.0.0.1:1234",
  })) {
    assert.throws(() => hostedConfig({ ...env(), [k]: v }), undefined, k);
  }
  const e = env();
  delete e.AUTH_ALLOWED_SUBJECT;
  assert.throws(() => hostedConfig(e));
  const now = Date.now(),
    enroll = {
      ...e,
      OAUTH_ENROLLMENT_ID: "fixture-issuance",
      OAUTH_ENROLLMENT_CAPABILITY: hex(),
      OAUTH_ENROLLMENT_EXPIRES: String(now + 900000),
    };
  assert.equal(hostedConfig(enroll, now).enrollment.kind, "enroll");
  assert.throws(() =>
    hostedConfig(
      { ...enroll, AUTH_ALLOWED_SUBJECT: env().AUTH_ALLOWED_SUBJECT },
      now,
    ),
  );
  // Startup's durable Enrollment boundary decides whether an expired issuance
  // is a recoverable saved candidate or a forbidden fresh enrollment.
  assert.equal(hostedConfig(enroll, now + 900001).enrollment.kind, "enroll");
});

test("hosted key custody is memory-only with independent secrets and bounded public retirement", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const key = {
    ...(await exportJWK(privateKey)),
    kid: "active",
    alg: "RS256",
    use: "sig",
  };
  const bundle = {
    encryption: hex(),
    lookup: hex(),
    cookie: hex(),
    signing: [key],
  };
  assert.equal(hostedKeys(JSON.stringify(bundle)).signing.length, 1);
  assert.throws(() =>
    hostedKeys(JSON.stringify({ ...bundle, cookie: bundle.lookup })),
  );
  assert.throws(() =>
    hostedKeys(JSON.stringify({ ...bundle, signing: [{ ...key, n: "AQAB" }] })),
  );
  const retiring = {
      kty: key.kty,
      n: key.n,
      e: key.e,
      kid: "retired",
      alg: "RS256",
      use: "sig",
    },
    now = Date.now();
  assert.equal(
    hostedKeys(
      JSON.stringify({ ...bundle, retiring, retiringUntil: now + 3600000 }),
      now,
    ).signing.length,
    2,
  );
  assert.throws(() =>
    hostedKeys(
      JSON.stringify({
        ...bundle,
        retiring: key,
        retiringUntil: now + 3600000,
      }),
      now,
    ),
  );
  assert.throws(() =>
    hostedKeys(
      JSON.stringify({ ...bundle, retiring, retiringUntil: now - 1 }),
      now,
    ),
  );
});

test("ownership claim never steals another process or crash residue and checks release identity", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ynab-lock-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "owner.lock"),
    first = claimProcess(path);
  const denied = spawnSync(
    process.execPath,
    [
      "--import",
      "./test/helpers/runtime-guard.mjs",
      "--input-type=module",
      "-e",
      `try {(await import('./dist/oauth/process-lock.js')).claimProcess(${JSON.stringify(join(dir, "fixture-denied.lock"))});}catch{}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /RUNTIME_GUARD.*"writes":1/);
  assert.throws(() => claimProcess(path));
  const value = readFileSync(path, "utf8");
  writeFileSync(path, hex());
  assert.throws(() => first.release());
  assert.throws(() => claimProcess(path));
  writeFileSync(path, value);
  first.release();
  const next = claimProcess(path);
  next.release();
  const nested = join(dir, "nested");
  mkdirSync(nested, { mode: 0o700 });
  symlinkSync(nested, path);
  assert.throws(() => claimProcess(path));
});

test("live mode requires all explicit switches and enrolled owner, excludes fixture allowlist", () => {
  const live = { ...env(), DATA_MODE: "live", LIVE_YNAB_ENABLED: "true" };
  assert.equal(hostedConfig(live).dataMode, "live");
  for (const change of [
    { LIVE_YNAB_ENABLED: undefined },
    { AUTH_ALLOWED_SUBJECT: undefined },
    { FIXTURE_ALLOWED_PLAN_IDS: "[]" },
    { LOCAL_FIXTURE_MODE: "true" },
    { DATA_MODE: "fixtures" },
  ])
    assert.throws(() => hostedConfig({ ...live, ...change }));
});

test("Claude static profile is optional, atomic and independent of existing credentials", () => {
  const base = env();
  assert.equal(hostedConfig(base).claude, undefined);
  const enabled = {
    ...base,
    OAUTH_CLAUDE_CLIENT_ID: "fixture-claude",
    OAUTH_CLAUDE_SECRET: hex(),
  };
  assert.deepEqual(hostedConfig(enabled).claude, {
    id: enabled.OAUTH_CLAUDE_CLIENT_ID,
    secret: enabled.OAUTH_CLAUDE_SECRET,
  });
  for (const override of [
    { OAUTH_CLAUDE_CLIENT_ID: undefined },
    { OAUTH_CLAUDE_SECRET: undefined },
    { OAUTH_CLAUDE_CLIENT_ID: "" },
    { OAUTH_CLAUDE_SECRET: "" },
    { OAUTH_CLAUDE_CLIENT_ID: base.OAUTH_NATIVE_CLIENT_ID },
    { OAUTH_CLAUDE_CLIENT_ID: base.OAUTH_WEB_CLIENT_ID },
    { OAUTH_CLAUDE_CLIENT_ID: "synthetic-client" },
    { OAUTH_CLAUDE_CLIENT_ID: "https://identity.example" },
    { OAUTH_CLAUDE_SECRET: base.OAUTH_WEB_SECRET },
    { OAUTH_CLAUDE_SECRET: "too-short" },
    { OAUTH_CLAUDE_SECRET: "synthetic-" + hex() },
    { OAUTH_CLAUDE_SECRET: "x".repeat(4097) },
  ])
    assert.throws(() => hostedConfig({ ...enabled, ...override }));
});
