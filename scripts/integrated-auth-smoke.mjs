// Orchestration only: synthetic keys/state are private temporary artifacts.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  authorize,
  exchange,
  harness,
} from "../test/helpers/integrated-auth.mjs";
import { runSmoke } from "./smoke-mcp.mjs";

let h, child, closed;
try {
  const mode = process.argv[3];
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--mode" ||
    !["start", "dev"].includes(mode)
  )
    throw Error();
  h = await harness(undefined, { startApp: false });
  child = spawn("npm", ["run", mode], {
    env: { PATH: process.env.PATH, ...h.env },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  closed = once(child, "close");
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error()), 15000);
    child.stderr.on("data", (b) => {
      output = (output + b).slice(-4096);
      if (output.includes('"code":"LISTENING"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer);
      reject(Error());
    });
  });
  for (const client of ["synthetic-native", "synthetic-web"]) {
    const a = await authorize(h, { client }),
      token = await exchange(
        h,
        a,
        client === "synthetic-web"
          ? { client_id: client, client_secret: h.env.OAUTH_WEB_SECRET }
          : {},
      );
    if (token.status !== 200) throw Error();
    await runSmoke(`${h.origin}/mcp`, () => {}, token.body.access_token);
  }
  process.kill(-child.pid, "SIGTERM");
  await closed;
  child = undefined;
  console.log(`INTEGRATED_AUTH_SMOKE_PASS ${mode}`);
} catch {
  console.error("INTEGRATED_AUTH_SMOKE_FAILED");
  process.exitCode = 1;
} finally {
  if (child) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await closed;
  }
  await h?.close();
}
