import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { runSmoke as baseRunSmoke } from "../scripts/smoke-mcp.mjs";
import {
  authorizedFetch as fetch,
  owner,
  sign,
  tokenFor,
} from "./helpers/auth.mjs";
import { launch, unusedPort } from "./helpers/process.mjs";

test("runtime guard detects network, persistent writes and subprocess attempts", () => {
  for (const script of [
    "globalThis.fetch('https://example.invalid')",
    "(await import('node:net')).connect(1, '127.0.0.1')",
    "(await import('node:fs')).writeFileSync('/tmp/ynab-guard-must-not-exist', 'synthetic')",
    "await (await import('node:fs/promises')).open('/tmp/ynab-guard-must-not-exist', 'w')",
    "(await import('node:child_process')).spawn('true')",
  ]) {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "./test/helpers/runtime-guard.mjs",
        "--input-type=module",
        "-e",
        `try { ${script}; } catch {} `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RUNTIME_GUARD.*:1/);
  }
});
test("instrumented running server handles both protocols and errors without outbound I/O or writes", async (t) => {
  const port = await unusedPort();
  const p = launch(port, {}, [
    "--import",
    "./test/helpers/runtime-guard.mjs",
    "dist/main.js",
  ]);
  t.after(() => p.stop());
  await p.ready;
  await runSmoke(`http://127.0.0.1:${port}/mcp`);
  const rejectedToken = await sign(`http://127.0.0.1:${port}/mcp`, {
    sub: "SECRET_SUBJECT",
    private_claim: "SECRET_CLAIM",
  });
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${rejectedToken}` },
        body: "SECRET_BODY",
      })
    ).status,
    403,
  );
  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: '{"SECRET_MARKER":',
  });
  assert.equal((await p.stop()).code, 0, p.output());
  assert.match(
    p.output(),
    /RUNTIME_GUARD {"network":0,"writes":0,"subprocess":0}/,
  );
  assert.ok(!p.output().includes("SECRET_MARKER"));
  for (const sentinel of [
    tokenFor(port),
    rejectedToken,
    owner,
    "SECRET_SUBJECT",
    "SECRET_CLAIM",
    "SECRET_BODY",
  ])
    assert.ok(!p.output().includes(sentinel));
  assert.ok(!p.output().includes("fixture-plan"));
  assert.ok(!p.output().includes("Error:"));
  assert.ok(!p.output().includes(" at "));
});
test("runtime source keeps filesystem, outbound adapters and dynamic evaluation out of fixture code", () => {
  const paths = readdirSync("src", { recursive: true }).filter((p) =>
    p.endsWith(".ts"),
  );
  for (const path of paths) {
    const source = readFileSync(`src/${path}`, "utf8");
    assert.doesNotMatch(
      ["auth/fixture-bundle.ts", "oauth/keys.ts", "oauth/store.ts", "oauth/process-lock.ts"].includes(
        path,
      )
        ? source.replaceAll("node:fs", "approved-read-loader")
        : source,
      /node:(?:fs|https|dns|dgram|child_process)|\beval\s*\(|\bnew Function\b/,
    );
    if (path !== "oauth/store.ts") assert.doesNotMatch(source, /node:sqlite/);
    assert.doesNotMatch(
      source,
      /YNAB_ACCESS_TOKEN\s*[=:]|\bhttps?\.(?:request|get)\s*\(/,
    );
    if (path !== "http.ts") assert.doesNotMatch(source, /\bfetch\s*\(/);
    if (path !== "ynab/transport.ts")
      assert.doesNotMatch(source, /https?:\/\/api\./);
    else
      assert.equal((source.match(/https:\/\/api\.ynab\.com/g) ?? []).length, 1);
  }
});

function runSmoke(url, report) {
  return baseRunSmoke(url, report, tokenFor(new URL(url).port));
}
