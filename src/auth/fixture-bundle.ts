import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { ConfigError } from "../errors.js";
import { discovery, keySet, record } from "./contracts.js";

export function loadBundle(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > 65536) throw new Error();
    const data = record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      ),
    );
    if (Object.keys(data).sort().join(",") !== "discovery,jwks")
      throw new Error();
    return { discovery: discovery(data.discovery), jwks: keySet(data.jwks) };
  } catch {
    throw new ConfigError("AUTH_FIXTURE_FILE");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
