// Test-only preload: install before the application and its dependencies import.
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const attempts = { network: 0, writes: 0, subprocess: 0 };
function blocked(kind) {
  return () => {
    attempts[kind]++;
    throw new Error(`GUARD_${kind.toUpperCase()}`);
  };
}
net.Socket.prototype.connect = blocked("network");
for (const target of [http, https])
  for (const key of ["request", "get"]) target[key] = blocked("network");
for (const target of [dns, dns.promises])
  for (const key of Object.keys(target)) {
    if (/^(lookup|resolve)/.test(key)) {
      const original = target[key].bind(target);
      target[key] = (host, ...args) => {
        // Node's listen path calls lookup even for a literal IP; that has no DNS I/O.
        if (key === "lookup" && net.isIP(host)) return original(host, ...args);
        return blocked("network")();
      };
    }
  }
dgram.createSocket = blocked("network");
globalThis.fetch = blocked("network");
for (const key of [
  "exec",
  "execFile",
  "spawn",
  "fork",
  "execSync",
  "execFileSync",
  "spawnSync",
])
  childProcess[key] = blocked("subprocess");
for (const target of [fs, fs.promises]) {
  for (const key of Object.keys(target)) {
    if (
      /^(write|append|truncate|ftruncate|mkdir|mkdtemp|rm|rmdir|unlink|rename|copy|cp|link|symlink|chmod|chown|fchmod|fchown|lchmod|lchown|utimes|futimes|lutimes|createWriteStream)/.test(
        key,
      )
    )
      target[key] = blocked("writes");
  }
  for (const key of ["open", "openSync"]) {
    if (!target[key]) continue;
    const original = target[key].bind(target);
    target[key] = (path, flags, ...rest) => {
      const readOnly =
        typeof flags === "number"
          ? flags === fs.constants.O_RDONLY
          : flags === "r" || flags === "rs";
      if (!readOnly) return blocked("writes")();
      return original(path, flags, ...rest);
    };
  }
}
syncBuiltinESMExports();
process.once("exit", () => {
  process.stderr.write(`RUNTIME_GUARD ${JSON.stringify(attempts)}\n`);
  if (Object.values(attempts).some((n) => n !== 0)) process.exitCode = 1;
});
