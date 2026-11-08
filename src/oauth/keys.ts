import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { JWK } from "jose";
import { fail } from "./crypto.js";
export function privatePath(path: string, directory: boolean) {
  if (!isAbsolute(path) || path !== realpathSync(path)) fail();
  let cursor = path;
  while (cursor !== dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) fail();
    cursor = dirname(cursor);
  }
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    fail();
  return path;
}
export type Keys = {
  encryption: Buffer;
  lookup: Buffer;
  cookie: string;
  signing: JWK[];
};
export function loadKeys(path: string, stateDir: string): Keys {
  privatePath(path, false);
  if (path.startsWith(`${stateDir}/`) || path === stateDir) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (lstatSync(path).size > 32768) fail();
    const v = JSON.parse(readFileSync(fd, "utf8"));
    const key = (value: unknown) => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
      return Buffer.from(value as string, "hex");
    };
    const encryption = key(v.encryption),
      lookup = key(v.lookup);
    if (
      encryption.equals(lookup) ||
      typeof v.cookie !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.cookie) ||
      !Array.isArray(v.signing) ||
      v.signing.length < 1 ||
      v.signing.length > 2
    )
      fail();
    const seen = new Set();
    for (const k of v.signing) {
      if (
        k.kty !== "RSA" ||
        k.alg !== "RS256" ||
        k.use !== "sig" ||
        typeof k.kid !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(k.kid) ||
        seen.has(k.kid) ||
        typeof k.n !== "string" ||
        Buffer.from(k.n, "base64url").length < 256 ||
        typeof k.d !== "string"
      )
        fail();
      seen.add(k.kid);
    }
    return { encryption, lookup, cookie: v.cookie, signing: v.signing };
  } catch {
    return fail();
  } finally {
    closeSync(fd);
  }
}
export function statePath(dir: string) {
  return join(privatePath(dir, true), "authorization.sqlite");
}
