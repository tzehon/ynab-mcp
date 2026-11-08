import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runSmoke } from "../scripts/smoke-mcp.mjs";
import { authorize, exchange, harness } from "./helpers/integrated-auth.mjs";
import { launch } from "./helpers/process.mjs";

test("integrated guard rejects native SQLite paths, ATTACH, file reads, network and subprocesses", async (t) => {
  const h = await harness(t);
  await h.stop();
  const cases = [
    "new (await import('node:sqlite')).DatabaseSync('/tmp/forbidden.db',{allowExtension:false})",
    "(await import('node:fs')).readFileSync('/etc/hosts')",
    "(await import('node:fs/promises')).open('/tmp/forbidden','w')",
    "await fetch('https://example.invalid')",
    "(await import('node:child_process')).spawn('true')",
  ];
  for (const code of cases) {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "./test/helpers/integrated-runtime-guard.mjs",
        "--input-type=module",
        "-e",
        `try{${code}}catch{}`,
      ],
      { env: { PATH: process.env.PATH, ...h.env }, encoding: "utf8" },
    );
    assert.equal(r.status, 1, code + " " + r.stderr);
    assert.match(r.stderr, /INTEGRATED_GUARD.*"denied":1/);
  }
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "./test/helpers/integrated-runtime-guard.mjs",
      "--input-type=module",
      "-e",
      `const {DatabaseSync}=await import('node:sqlite');const d=new DatabaseSync(process.env.OAUTH_STATE_DIR+'/authorization.sqlite',{allowExtension:false});try{d.exec("ATTACH ':memory:' AS outside");process.exitCode=2}catch{}d.close()`,
    ],
    { env: { PATH: process.env.PATH, ...h.env }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
});
test("guarded integrated application performs only approved local flow and state I/O", async (t) => {
  const h = await harness(t);
  await h.stop();
  const p = launch(Number(h.env.PORT), h.env, [
    "--import",
    "./test/helpers/integrated-runtime-guard.mjs",
    "dist/main.js",
  ]);
  t.after(() => p.stop());
  await p.ready;
  const a = await authorize(h),
    token = await exchange(h, a);
  assert.equal(token.status, 200);
  await runSmoke(`${h.origin}/mcp`, () => {}, token.body.access_token);
  assert.equal((await p.stop()).code, 0, p.output());
  assert.match(p.output(), /INTEGRATED_GUARD.*"denied":0/);
  for (const secret of [
    token.body.access_token,
    h.env.OAUTH_WEB_SECRET,
    h.env.MOCK_YNAB_SECRET,
  ])
    assert(!p.output().includes(secret));
});
