// Operator-only preparation. Never invoked by startup or the container build.
import {
  constants,
  openSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
try {
  const path = process.argv[2];
  if (process.argv.length !== 3 || !path || !isAbsolute(path)) throw Error();
  const dir = dirname(path),
    stat = lstatSync(dir);
  if (
    realpathSync(dir) !== dir ||
    !stat.isDirectory() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid()
  )
    throw Error();
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const hex = () => randomBytes(32).toString("hex");
  const bundle = {
    encryption: hex(),
    lookup: hex(),
    cookie: hex(),
    signing: [
      {
        ...(await exportJWK(privateKey)),
        kid: randomBytes(16).toString("hex"),
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(bundle));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
} catch {
  console.error("KEY_PREPARATION_REJECTED");
  process.exitCode = 1;
}
