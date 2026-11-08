import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../dist/config.js";
import { harness } from "./helpers/integrated-auth.mjs";

test("integrated config retains local fixture gates and refuses mismatched/live settings", async (t) => {
  const h = await harness(t);
  for (const patch of [
    { LOCAL_FIXTURE_MODE: "false" },
    { DATA_MODE: "live" },
    { HOST: "0.0.0.0" },
    { NODE_ENV: "production" },
    { AUTH_MODE: "live" },
    { AUTH_ISSUER: "https://provider.example" },
    { AUTH_AUDIENCE: "https://other/mcp" },
    { MOCK_YNAB_ORIGIN: "http://localhost:3001/" },
    { MOCK_YNAB_ORIGIN: "https://api.ynab.com/" },
    { MOCK_YNAB_ORIGIN: `${h.origin}/` },
    { OAUTH_NATIVE_CALLBACK: "http://127.0.0.1:4/callback?x=y" },
    { OAUTH_WEB_SECRET: "actual-secret" },
    { YNAB_CLIENT_SECRET: "actual-secret" },
    { YNAB_ACCESS_TOKEN: "actual-token" },
    { AUTH_ALLOWED_SUBJECT: "owner-email" },
  ])
    assert.throws(() => parseConfig({ ...h.env, ...patch }));
  for (const name of ["OAUTH_KEY_FILE", "OAUTH_STATE_DIR", "MOCK_YNAB_SECRET"])
    assert.throws(() => parseConfig({ ...h.env, [name]: "" }));
});

test("missing, oversized or insecure key bundle and symlinked state are refused", async (t) => {
  const { readFileSync, writeFileSync, chmodSync, symlinkSync } = await import(
    "node:fs"
  );
  const { loadKeys } = await import("../dist/oauth/keys.js");
  const { Store } = await import("../dist/oauth/store.js");
  const h = await harness(t);
  await h.stop();
  const bytes = readFileSync(h.keyFile);
  chmodSync(h.keyFile, 0o644);
  assert.throws(() => loadKeys(h.keyFile, h.dir));
  chmodSync(h.keyFile, 0o600);
  writeFileSync(h.keyFile, "x".repeat(32769));
  assert.throws(() => loadKeys(h.keyFile, h.dir));
  writeFileSync(h.keyFile, bytes);
  const keys = loadKeys(h.keyFile, h.dir);
  symlinkSync(h.dir, `${h.root}/alias`);
  assert.throws(() => new Store(`${h.root}/alias`, keys));
  assert.throws(() => loadKeys(`${h.root}/missing`, h.dir));
});
