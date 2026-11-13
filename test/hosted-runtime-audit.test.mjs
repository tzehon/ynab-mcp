import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import test from "node:test";

test("hosted I/O guard permits only claimed storage/socket and denies alternate native paths", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ynab-hosted-guard-"))),
    state = join(root, "state"),
    runtime = join(root, "runtime");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    OAUTH_STATE_DIR: state,
    HOSTED_TEST_RUNTIME_DIR: runtime,
    HOSTED_TEST_UPSTREAM: "https://127.0.0.1:1",
  };
  const run = (code) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./test/helpers/hosted-runtime-guard.mjs",
        "--input-type=module",
        "-e",
        code,
      ],
      { env, encoding: "utf8", timeout: 8000 },
    );
  for (const code of [
    "(await import('node:fs')).readFileSync('/etc/hosts')",
    "(await import('node:fs')).writeFileSync('/tmp/ynab-forbidden','x')",
    "(await import('node:fs/promises')).open('/tmp/ynab-forbidden','w')",
    "new (await import('node:sqlite')).DatabaseSync('/tmp/ynab-forbidden.db',{allowExtension:false})",
    "(await import('node:net')).createServer().listen('/tmp/ynab-forbidden.sock')",
    "(await import('node:net')).connect({host:'example.invalid',port:443})",
    "(await import('node:dns')).lookup('example.invalid',()=>{})",
    "(await import('node:child_process')).spawn('true')",
    "await fetch('https://api.ynab.com/v1/plans')",
    "(await import('node:https')).request({hostname:'127.0.0.1',port:1,path:'/v1/plans',headers:{host:'api.ynab.com'}})",
  ]) {
    const r = run(`try{${code}}catch{}`);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /HOSTED_GUARD.*"denied":1/);
  }
  const hex = () => randomBytes(32).toString("hex"),
    { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const bundle = {
    encryption: hex(),
    lookup: hex(),
    cookie: hex(),
    signing: [
      {
        ...(await exportJWK(privateKey)),
        kid: "fixture",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  const r = run(`
    const {hostedService}=await import('./dist/oauth/hosted-service.js');
    const app=await hostedService({origin:'https://fixture.up.railway.app',dir:process.env.OAUTH_STATE_DIR,runtimeDir:process.env.HOSTED_TEST_RUNTIME_DIR,keyBundle:${JSON.stringify(JSON.stringify(bundle))},ynabId:'fixture-upstream',ynabSecret:'fixture-control-secret',enrollment:{kind:'enroll',issuance:'fixture-issuance',capability:'a'.repeat(64),expires:Date.now()+900000}});
    app.ready();await app.close();
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.env.OAUTH_STATE_DIR+'/authorization.sqlite',{allowExtension:false});
    try{db.exec("ATTACH ':memory:' AS outside");process.exitCode=2}catch{}db.close();
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /HOSTED_GUARD.*"denied":0/);
  assert.match(r.stderr, /"database":2/);
});

test("live hosted guard admits only exact synthetic GET vocabulary and retains fixture denial", () => {
  const run = (path, method = "GET", live = "true") =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./test/helpers/hosted-runtime-guard.mjs",
        "--input-type=module",
        "-e",
        `try {const req=(await import('node:https')).request({hostname:'127.0.0.1',port:1,path:${JSON.stringify(path)},method:${JSON.stringify(method)},headers:{host:'api.ynab.com'}});req.on('error',()=>{});req.end();}catch{}`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          OAUTH_STATE_DIR: "/private/tmp/unused-live-guard",
          HOSTED_TEST_RUNTIME_DIR: "/private/tmp/unused-live-runtime",
          HOSTED_TEST_UPSTREAM: "https://127.0.0.1:1",
          HOSTED_TEST_LIVE: live,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
  for (const path of [
    "/v1/plans",
    "/v1/plans/11111111-1111-4111-8111-111111111111/accounts",
  ]) {
    const result = run(path);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /HOSTED_GUARD.*"denied":0,"network":1/);
    assert.equal(run(path, "GET", "false").status, 1);
  }
  for (const [path, method] of [
    ["/v1/plans", "POST"],
    ["/v1/plans?include_accounts=true", "GET"],
    ["/v1/plans/22222222-2222-4222-8222-222222222222/accounts", "GET"],
    ["/v1/plans/11111111-1111-4111-8111-111111111111/accounts?x=1", "GET"],
  ]) {
    const result = run(path, method);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /HOSTED_GUARD.*"denied":1/);
  }
});
