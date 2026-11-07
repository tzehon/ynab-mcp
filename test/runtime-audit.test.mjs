import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { launch, unusedPort } from "./helpers/process.mjs";
import { runSmoke } from "../scripts/smoke-mcp.mjs";

test("runtime guard detects network, persistent writes and subprocess attempts", () => {
  for (const script of [
    "fetch('https://example.invalid')",
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
      source,
      /node:(?:fs|https|dns|dgram|child_process)|\beval\s*\(|\bnew Function\b/,
    );
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
