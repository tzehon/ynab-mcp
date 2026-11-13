// Hosted-only regression instrumentation. The separate local guards are unchanged.
// Install after the fixture creates its test-only paths and TLS server.
// This is regression instrumentation, not a malicious-code sandbox.
import cp from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { resolve } from "node:path";
import sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "../.."),
  state = process.env.OAUTH_STATE_DIR,
  runtime = process.env.HOSTED_TEST_RUNTIME_DIR,
  upstream = new URL(process.env.HOSTED_TEST_UPSTREAM);
const attempts = { denied: 0, network: 0, database: 0, reads: 0, writes: 0 };
const deny = () => {
  attempts.denied++;
  throw Error("HOSTED_GUARD_DENIED");
};
const pathOf = (p) =>
  p instanceof URL
    ? fileURLToPath(p)
    : typeof p === "string"
      ? resolve(p)
      : undefined;
const dbPaths = new Set(
  [
    "authorization.sqlite",
    "authorization.sqlite-wal",
    "authorization.sqlite-shm",
  ].map((n) => `${state}/${n}`),
);
const canRead = (p) => {
  const v = pathOf(p);
  return (
    v === runtime ||
    v === `${runtime}/admin.sock` ||
    v === `${state}/owner.lock` ||
    v === state ||
    dbPaths.has(v) ||
    (v?.startsWith(`${root}/`) &&
      (/\.(?:m?js|json|ts)$/.test(v) || v.includes("/node_modules/")))
  );
};
const canWrite = (p) =>
  dbPaths.has(pathOf(p)) ||
  pathOf(p) === `${state}/owner.lock` ||
  pathOf(p) === `${runtime}/admin.sock`;
const fds = new Map();
for (const target of [fs, fs.promises]) {
  for (const name of ["readFile", "readFileSync", "createReadStream"])
    if (target[name]) {
      const old = target[name].bind(target);
      target[name] = (p, ...args) => {
        if (typeof p === "number" ? !fds.has(p) : !canRead(p)) deny();
        attempts.reads++;
        return old(p, ...args);
      };
    }
  for (const name of [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "truncate",
    "truncateSync",
    "unlink",
    "unlinkSync",
    "chmod",
    "chmodSync",
  ])
    if (target[name]) {
      const old = target[name].bind(target);
      target[name] = (p, ...args) => {
        if (typeof p === "number" ? !canWrite(fds.get(p)) : !canWrite(p))
          deny();
        attempts.writes++;
        return old(p, ...args);
      };
    }
  for (const name of [
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "rename",
    "renameSync",
    "symlink",
    "symlinkSync",
    "link",
    "linkSync",
    "createWriteStream",
    "mkdir",
    "mkdirSync",
    "rm",
    "rmSync",
    "rmdir",
    "rmdirSync",
    "mkdtemp",
    "mkdtempSync",
  ])
    if (target[name]) target[name] = deny;
}
const open = fs.openSync.bind(fs);
fs.openSync = (p, flags, ...args) => {
  const writes =
    typeof flags === "number"
      ? (flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT)) !==
        0
      : flags !== "r" && flags !== "rs";
  if (writes ? !canWrite(p) : !canRead(p)) deny();
  const fd = open(p, flags, ...args);
  fds.set(fd, pathOf(p));
  return fd;
};
const close = fs.closeSync.bind(fs);
fs.closeSync = (fd) => {
  fds.delete(fd);
  return close(fd);
};
// App uses synchronous bounded key reads and SQLite only; async opens are unnecessary.
fs.open = deny;
fs.promises.open = deny;
for (const name of [
  "write",
  "writeSync",
  "ftruncate",
  "ftruncateSync",
  "fchmod",
  "fchmodSync",
])
  if (fs[name]) fs[name] = deny;
const Original = sqlite.DatabaseSync;
class GuardedDatabase extends Original {
  constructor(p, options = {}) {
    if (
      pathOf(p) !== `${state}/authorization.sqlite` ||
      options.allowExtension !== false
    )
      deny();
    super(p, options);
    attempts.database++;
    const authorizer = super.setAuthorizer.bind(this);
    this.setAuthorizer = (fn) =>
      authorizer((action, ...args) => {
        if (
          [
            sqlite.constants.SQLITE_ATTACH,
            sqlite.constants.SQLITE_DETACH,
          ].includes(action)
        )
          return sqlite.constants.SQLITE_DENY;
        return fn(action, ...args);
      });
    this.setAuthorizer(() => sqlite.constants.SQLITE_OK);
  }
  enableLoadExtension(enabled) {
    if (enabled) deny();
    return super.enableLoadExtension(false);
  }
  loadExtension() {
    return deny();
  }
}
sqlite.DatabaseSync = GuardedDatabase;
if (sqlite.Database === Original) sqlite.Database = GuardedDatabase;
sqlite.backup = deny;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (
    (typeof args[0] === "string" || args[0]?.path) &&
    (args[0]?.path ?? args[0]) !== `${runtime}/admin.sock`
  )
    return deny();
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (
    typeof a !== "object" ||
    Number(a.port) !== Number(upstream.port) ||
    ![upstream.hostname, `${upstream.hostname}:${upstream.port}`].includes(
      a.host ?? a.hostname,
    )
  )
    return deny();
  return connect.apply(this, args);
};
for (const target of [dgram])
  for (const name of ["request", "get", "createSocket"])
    if (target[name]) target[name] = deny;
for (const target of [dns, dns.promises])
  for (const name of Object.keys(target))
    if (/^(lookup|resolve)/.test(name)) {
      const old = target[name].bind(target);
      target[name] = (host, ...args) =>
        name === "lookup" && net.isIP(host) ? old(host, ...args) : deny();
    }
for (const name of [
  "exec",
  "execFile",
  "spawn",
  "fork",
  "execSync",
  "execFileSync",
  "spawnSync",
])
  cp[name] = deny;
const livePaths = new Set([
  "/v1/plans",
  ...[
    "accounts",
    "categories",
    "months/2026-11-01",
    "transactions?since_date=2026-11-01&until_date=2026-11-07",
  ].map((tail) => `/v1/plans/11111111-1111-4111-8111-111111111111/${tail}`),
]);
const allowed = (url, method) =>
  (process.env.HOSTED_TEST_LIVE === "true" &&
    method === "GET" &&
    [...livePaths].some((path) => url === `https://api.ynab.com${path}`)) ||
  (url === "https://app.ynab.com/oauth/token" && method === "POST") ||
  (url === "https://api.ynab.com/v1/user" && method === "GET");
const fetcher = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!allowed(url, init?.method ?? "GET")) deny();
  attempts.network++;
  return fetcher(input, init);
};
for (const name of ["request", "get"]) {
  http[name] = deny;
  const original = https[name];
  https[name] = function (input, ...args) {
    // The test fixture maps the two fixed identities onto its trusted local TLS
    // server. No other host, method, path or native socket target is permitted.
    if (
      !input ||
      typeof input !== "object" ||
      input instanceof URL ||
      input.hostname !== upstream.hostname ||
      Number(input.port) !== Number(upstream.port) ||
      !allowed(
        `https://${input.headers?.host}${input.path}`,
        input.method ?? "GET",
      )
    )
      deny();
    attempts.network++;
    return original.call(this, input, ...args);
  };
}
// SQLite's named ESM export is not rewritten by syncBuiltinESMExports.
// Route subsequent imports through a checked export, including direct native opens.
const sqliteGuard = Symbol.for("ynab.test.sqlite.guard");
globalThis[sqliteGuard] = {
  DatabaseSync: GuardedDatabase,
  Database: GuardedDatabase,
  constants: sqlite.constants,
  backup: deny,
};
const wrapper =
  "data:text/javascript," +
  encodeURIComponent(
    "const s=globalThis[Symbol.for('ynab.test.sqlite.guard')];export const DatabaseSync=s.DatabaseSync,Database=s.Database,constants=s.constants,backup=s.backup;export default s;",
  );
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:sqlite" || specifier === "sqlite")
      return { url: wrapper, shortCircuit: true };
    if (["node:ffi", "node:worker_threads"].includes(specifier)) deny();
    return next(specifier, context);
  },
});
syncBuiltinESMExports();
process.once("exit", () => {
  process.stderr.write(`HOSTED_GUARD ${JSON.stringify(attempts)}\n`);
  if (attempts.denied) process.exitCode = 1;
});
