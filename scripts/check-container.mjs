import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";

const suffix = randomBytes(6).toString("hex"),
  image = `ynab-mcp:check-${suffix}`,
  volume = `ynab6-check-${suffix}`;
const root = mkdtempSync(join(tmpdir(), "ynab-container-")),
  envFile = join(root, "runtime.env");
const owned = new Set();
const buildCanary = `fixture-build-exclusion-${suffix}`;
const canaryPath = `.env.ynab-container-${suffix}`;
writeFileSync(canaryPath, buildCanary, { mode: 0o600 });
let volumeCreated = false;
function docker(args, { ok = true, input } = {}) {
  const r = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (ok && r.status !== 0)
    throw Error(
      `CONTAINER_CHECK_FAILED: docker ${args[0]}: ${r.error?.code ?? r.status}`,
    );
  return r;
}
const hex = () => randomBytes(32).toString("hex");
try {
  docker(["info"]);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  docker([
    "build",
    "--build-arg",
    `SOURCE_REVISION=${revision}`,
    "-t",
    image,
    ".",
  ]);
  const archive = join(root, "image.tar");
  docker(["save", "--output", archive, image]);
  let trailing = "";
  for await (const chunk of createReadStream(archive)) {
    const text = trailing + chunk.toString("latin1");
    assert(!text.includes(buildCanary));
    trailing = text.slice(-buildCanary.length);
  }
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const bundle = JSON.stringify({
    encryption: hex(),
    lookup: hex(),
    cookie: hex(),
    signing: [
      {
        ...(await exportJWK(privateKey)),
        kid: "container-canary",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
  const env = {
    AUTH_MODE: "integrated-hosted",
    HOSTED_AUTHORIZATION_ENABLED: "true",
    NODE_ENV: "production",
    DATA_MODE: "fixtures",
    PORT: "3000",
    AUTH_ISSUER: "https://fixture-container.up.railway.app",
    AUTH_AUDIENCE: "https://fixture-container.up.railway.app/mcp",
    MCP_PUBLIC_URL: "https://fixture-container.up.railway.app/mcp",
    OAUTH_STATE_DIR: "/data/authorization",
    OAUTH_KEY_BUNDLE: bundle,
    OAUTH_NATIVE_CLIENT_ID: "fixture-native",
    OAUTH_WEB_CLIENT_ID: "fixture-web",
    OAUTH_NATIVE_CALLBACK: "http://127.0.0.1:9876/callback",
    OAUTH_WEB_CALLBACK: "https://client.example/callback",
    OAUTH_WEB_AUTH_METHOD: "client_secret_post",
    OAUTH_WEB_SECRET: hex(),
    YNAB_CLIENT_ID: "fixture-upstream",
    YNAB_CLIENT_SECRET: hex(),
    OAUTH_ENROLLMENT_ID: `fixture-${suffix}`,
    OAUTH_ENROLLMENT_CAPABILITY: hex(),
    OAUTH_ENROLLMENT_EXPIRES: String(Date.now() + 900000),
  };
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    { mode: 0o600 },
  );
  docker(["volume", "create", volume]);
  volumeCreated = true;
  const launch = () => {
    const id = docker([
      "run",
      "-d",
      "--network",
      "none",
      "--env-file",
      envFile,
      "--mount",
      `type=volume,src=${volume},dst=/data`,
      image,
    ]).stdout.trim();
    owned.add(id);
    return id;
  };
  const node = (id, code, ok = true) =>
    docker(
      [
        "exec",
        "--user",
        "1000:1000",
        id,
        "node",
        "--input-type=module",
        "-e",
        code,
      ],
      { ok },
    );
  const http = (id, path, host = "fixture-container.up.railway.app") =>
    node(
      id,
      `import http from 'node:http';const r=http.get({host:'127.0.0.1',port:3000,path:${JSON.stringify(path)},headers:{host:${JSON.stringify(host)}}},s=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>console.log(JSON.stringify({status:s.statusCode,body:b})));});r.on('error',()=>process.exit(1));`,
    ).stdout;
  const ready = async (id) => {
    for (let i = 0; i < 60; i++) {
      const result = node(
        id,
        "import http from 'node:http';const r=http.get({host:'127.0.0.1',port:3000,path:'/healthz',headers:{host:'fixture-container.up.railway.app'}},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1));});r.on('error',()=>process.exit(1));",
        false,
      );
      if (result.status === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const logs = docker(["logs", id], { ok: false });
    writeFileSync(
      "/tmp/ynab6-container-failure.log",
      logs.stdout + logs.stderr,
      { mode: 0o600 },
    );
    throw Error("CONTAINER_NOT_READY");
  };
  let id = launch();
  await ready(id);
  assert.equal(JSON.parse(http(id, "/healthz")).status, 200);
  assert.equal(JSON.parse(http(id, "/mcp")).status, 403);
  assert.equal(JSON.parse(http(id, "/auth")).status, 403);
  assert.equal(
    JSON.parse(http(id, "/auth", "healthcheck.railway.app")).status,
    403,
  );
  assert.equal(
    JSON.parse(http(id, "/healthz", "healthcheck.railway.app")).status,
    200,
  );
  assert.equal(
    node(
      id,
      "import fs from 'node:fs';const s=fs.readFileSync('/proc/1/status','utf8');if(!/^Uid:\\s+1000\\s+1000\\s+1000\\s+1000$/m.test(s))process.exit(1);",
    ).status,
    0,
  );
  node(
    id,
    "import fs from 'node:fs';for(const p of ['/app/test','/app/.git','/app/.local'])if(fs.existsSync(p))process.exit(1);for(const p of ['/data/authorization','/run/ynab-mcp'])if((fs.statSync(p).mode&0o777)!==0o700)process.exit(1);if((fs.statSync('/run/ynab-mcp/admin.sock').mode&0o777)!==0o600)process.exit(1);",
  );
  const admin = docker([
    "exec",
    "--user",
    "1000:1000",
    id,
    "node",
    "scripts/authorization-admin.mjs",
    "status",
  ]).stdout;
  assert.equal(JSON.parse(admin).phase, "available");
  assert.notEqual(
    docker(
      [
        "exec",
        "--user",
        "65534:65534",
        id,
        "node",
        "scripts/authorization-admin.mjs",
        "status",
      ],
      { ok: false },
    ).status,
    0,
  );
  const contender = launch();
  const exit = docker(["wait", contender]).stdout.trim();
  assert.notEqual(exit, "0");
  const logs = docker(["logs", id]).stdout + docker(["logs", id]).stderr;
  for (const value of [
    env.OAUTH_ENROLLMENT_CAPABILITY,
    env.OAUTH_WEB_SECRET,
    env.YNAB_CLIENT_SECRET,
    JSON.parse(bundle).encryption,
  ])
    assert(!logs.includes(value));
  const stop = Date.now();
  docker(["stop", "--time", "10", id]);
  assert(Date.now() - stop < 11000);
  id = launch();
  await ready(id);
  assert.equal(
    JSON.parse(
      docker([
        "exec",
        "--user",
        "1000:1000",
        id,
        "node",
        "scripts/authorization-admin.mjs",
        "status",
      ]).stdout,
    ).phase,
    "available",
  );
  docker(["kill", id]);
  docker(["wait", id]);
  const crashed = launch();
  assert.notEqual(docker(["wait", crashed]).stdout.trim(), "0");
  // Every previous container is stopped here. Only a matching observed claim
  // can be removed; an incorrect fingerprint must preserve crash evidence.
  const offline = (args, input, ok = true) =>
    docker(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--env-file",
        envFile,
        "--mount",
        `type=volume,src=${volume},dst=/data`,
        image,
        ...args,
      ],
      { input, ok },
    );
  const fingerprint = offline([
    "node",
    "--input-type=module",
    "-e",
    "import fs from 'node:fs';import crypto from 'node:crypto';console.log(crypto.createHash('sha256').update(fs.readFileSync('/data/authorization/owner.lock')).digest('hex'))",
  ]).stdout.trim();
  assert.notEqual(
    offline(
      ["node", "scripts/recover-ownership.mjs", "--confirmed-stopped"],
      "0".repeat(64) + "\n",
      false,
    ).status,
    0,
  );
  assert.equal(
    offline(
      ["node", "scripts/recover-ownership.mjs", "--confirmed-stopped"],
      fingerprint + "\n",
    ).stdout.trim(),
    "OWNERSHIP_RELEASED",
  );
  id = launch();
  await ready(id);
  docker(["stop", "--time", "10", id]);
  // Entrypoint must refuse an authorization-directory symlink without touching
  // its target. Use a disposable mount root unrelated to the exercised store.
  const symlinked = docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      image,
      "-c",
      "mkdir /data; ln -s /tmp /data/authorization; exec /usr/local/bin/ynab-entrypoint node dist/main.js",
    ],
    { ok: false },
  );
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /CONTAINER_SETUP_REJECTED/);
  console.log(
    "CONTAINER_CHECK_OK: pinned image, unprivileged PID 1, private volume/socket, bootstrap denial, competing-process refusal, orderly restart, crash residue, bounded offline recovery, symlink refusal, image canary exclusion, no secret logs",
  );
} finally {
  for (const id of owned) docker(["rm", "-f", id], { ok: false });
  if (volumeCreated) docker(["volume", "rm", volume], { ok: false });
  docker(["image", "rm", image], { ok: false });
  rmSync(root, { recursive: true, force: true });
  rmSync(canaryPath, { force: true });
}
