// Offline operator operation only: independently stop every previous deployment
// before invoking this helper. No lease expiry or PID heuristic proves that.
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
const dir = "/data/authorization",
  path = `${dir}/owner.lock`;
try {
  if (process.argv.length !== 3 || process.argv[2] !== "--confirmed-stopped")
    throw Error();
  const parent = lstatSync(dir);
  if (
    realpathSync(dir) !== dir ||
    !parent.isDirectory() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o077
  )
    throw Error();
  const timer = setTimeout(() => {
    console.error("RECOVERY_REJECTED");
    process.exit(1);
  }, 3000);
  let expected = "";
  for await (const chunk of process.stdin) {
    expected += chunk;
    if (expected.length > 65) throw Error();
  }
  clearTimeout(timer);
  expected = expected.trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== 64 ||
      before.uid !== process.getuid() ||
      before.mode & 0o077
    )
      throw Error();
    const actual = createHash("sha256").update(readFileSync(fd)).digest("hex"),
      after = lstatSync(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      after.isSymbolicLink() ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw Error();
    unlinkSync(path);
  } finally {
    closeSync(fd);
  }
  console.log("OWNERSHIP_RELEASED");
} catch {
  console.error("RECOVERY_REJECTED");
  process.exitCode = 1;
}
