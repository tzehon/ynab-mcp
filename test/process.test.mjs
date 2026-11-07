import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { launch, unusedPort } from "./helpers/process.mjs";
import { runSmoke } from "../scripts/smoke-mcp.mjs";

test("spawned server exits without binding on invalid startup and redacts diagnostics", async () => {
  for (const extra of [
    { LOCAL_FIXTURE_MODE: undefined },
    { DATA_MODE: "live" },
    { NODE_ENV: "production" },
    { NODE_ENV: "unknown" },
    { HOST: "0.0.0.0" },
    { PORT: "0" },
    { PORT: "-1" },
    { PORT: "1.5" },
    { PORT: "nonnumeric" },
    { PORT: "65536" },
    { YNAB_ACCESS_TOKEN: "SECRET_MARKER" },
    { FIXTURE_ALLOWED_PLAN_IDS: "SECRET_MARKER" },
  ]) {
    const port = await unusedPort(),
      p = launch(port, extra),
      result = await p.exited;
    assert.equal(result.code, 1);
    assert.ok(!p.output().includes("SECRET_MARKER"));
    assert.ok(!p.output().includes('"code":"LISTENING"'));
    await new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.destroy();
        reject(new Error("UNEXPECTED_LISTENER"));
      });
      s.on("error", resolve);
    });
  }
});
test("SIGINT and SIGTERM close resources; same-port restart and both smoke eras succeed", {
  timeout: 20000,
}, async (t) => {
  const port = await unusedPort();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const p = launch(port);
    t.after(() => p.stop());
    await p.ready;
    const eras = [];
    await runSmoke(`http://127.0.0.1:${port}/mcp`, (e) => eras.push(e));
    assert.deepEqual(eras, ["legacy", "modern"]);
    const started = performance.now();
    const result = await p.stop(signal);
    assert.equal(result.code, 0, p.output());
    assert.ok(performance.now() - started < 5000);
  }
});
test("port conflict fails nonzero without disturbing the existing listener", async (t) => {
  const port = await unusedPort(),
    a = launch(port);
  t.after(() => a.stop());
  await a.ready;
  const b = launch(port);
  assert.equal((await b.exited).code, 1);
  assert.ok(!b.output().includes("Error:"));
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});
