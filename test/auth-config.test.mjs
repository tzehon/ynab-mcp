import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseConfig } from "../dist/config.js";
import { loadBundle } from "../dist/auth/fixture-bundle.js";
import { fixtureEnv, fixtureFile, bundle } from "./helpers/auth.mjs";
test("auth settings are required, exact and safely rejected", () => {
  for (const name of [
    "AUTH_ISSUER",
    "AUTH_AUDIENCE",
    "MCP_PUBLIC_URL",
    "AUTH_ALLOWED_SUBJECT",
    "AUTH_FIXTURE_FILE",
  ])
    for (const value of [undefined, "", " SECRET_MARKER "])
      assert.throws(
        () => parseConfig({ ...fixtureEnv, [name]: value }),
        (e) => e.message === `CONFIG_${name}`,
      );
  for (const value of [
    "http://localhost:3000/mcp",
    "http://127.0.0.1:3000/mcp/",
    "http://127.0.0.1:3000/mcp?q=x",
    "http://127.0.0.1:3000/mcp#x",
    "http://127.0.0.1:3001/mcp",
  ])
    assert.throws(() =>
      parseConfig({
        ...fixtureEnv,
        AUTH_AUDIENCE: value,
        MCP_PUBLIC_URL: value,
      }),
    );
  for (const value of ["x".repeat(129), "\u0001", "owner\n"])
    assert.throws(() =>
      parseConfig({ ...fixtureEnv, AUTH_ALLOWED_SUBJECT: value }),
    );
});
test("public bundle loader bounds regular files and rejects secret key material", (t) => {
  assert.equal(loadBundle(fixtureFile).jwks.keys.length, 1);
  const dir = mkdtempSync(join(tmpdir(), "ynab-bundle-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "input");
  for (const text of [
    "{",
    " ".repeat(65537),
    JSON.stringify({ ...bundle, secret: "SENTINEL" }),
    JSON.stringify({
      ...bundle,
      jwks: { keys: [{ ...bundle.jwks.keys[0], d: "SENTINEL" }] },
    }),
  ]) {
    writeFileSync(file, text);
    assert.throws(
      () => loadBundle(file),
      (e) => e.message === "CONFIG_AUTH_FIXTURE_FILE",
    );
  }
  assert.throws(() => loadBundle(dir));
  assert.throws(() => loadBundle(join(dir, "missing")));
  symlinkSync(fixtureFile, join(dir, "link"));
  assert.throws(() => loadBundle(join(dir, "link")));
  assert.equal(spawnSync("mkfifo", [join(dir, "pipe")]).status, 0);
  const begin = performance.now();
  assert.throws(() => loadBundle(join(dir, "pipe")));
  assert.ok(performance.now() - begin < 500);
});
test("runtime guard accepts bounded read-only flags and still blocks numeric writes", () => {
  const run = (code) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./test/helpers/runtime-guard.mjs",
        "--input-type=module",
        "-e",
        code,
      ],
      { encoding: "utf8" },
    );
  const read = run(
    `import {loadBundle} from './dist/auth/fixture-bundle.js';loadBundle(${JSON.stringify(fixtureFile)});`,
  );
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stderr, /"writes":0/);
  for (const flag of ["O_WRONLY", "O_RDWR", "O_CREAT", "O_APPEND", "O_TRUNC"]) {
    const r = run(
      `import fs from 'node:fs';try{fs.openSync('/tmp/never-written',fs.constants.${flag}|fs.constants.O_NONBLOCK)}catch{}`,
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"writes":1/);
  }
});
