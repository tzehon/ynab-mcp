import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

for (const mode of ["start", "dev"])
  test(`documented integrated fixture harness: ${mode}`, {
    timeout: 30000,
  }, async () => {
    const p = spawn(
      process.execPath,
      ["scripts/integrated-auth-smoke.mjs", "--mode", mode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    p.stdout.on("data", (b) => (output += b));
    p.stderr.on("data", (b) => (output += b));
    const timer = setTimeout(() => p.kill("SIGKILL"), 27000);
    const [code] = await once(p, "close");
    clearTimeout(timer);
    assert.equal(code, 0, output);
    assert.equal(output, `INTEGRATED_AUTH_SMOKE_PASS ${mode}\n`);
  });
