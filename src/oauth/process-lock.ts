import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fail } from "./crypto.js";
import { privatePath } from "./keys.js";

// Claim lives beside the SQLite directory. No timeout, PID or heartbeat can
// authorize stealing it. Crash residue requires an operator-proven stop.
export function claimProcess(path: string) {
  privatePath(dirname(path), true);
  const token = randomBytes(32).toString("hex");
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return fail();
  }
  let inode: number;
  try {
    writeFileSync(fd, token);
    inode = fstatSync(fd).ino;
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      privatePath(path, false);
      const actual = readFileSync(path);
      if (
        actual.length !== 64 ||
        lstatSync(path).ino !== inode ||
        !timingSafeEqual(actual, Buffer.from(token))
      )
        fail();
      unlinkSync(path);
      released = true;
    },
  };
}
