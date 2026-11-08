// Test-only orchestration: keys stay in this parent, only public material reaches the server.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  fixtureEnv,
  portEnv,
  unusedPort,
  tokenFor,
  sign,
} from "../test/helpers/auth.mjs";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

let child;
try {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--mode" ||
    !["start", "dev"].includes(process.argv[3])
  )
    throw new Error();
  const mode = process.argv[3],
    port = await unusedPort();
  const url = `http://127.0.0.1:${port}/mcp`;
  child = spawn("npm", ["run", mode], {
    env: { PATH: process.env.PATH, ...fixtureEnv, ...portEnv(port) },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  const closed = once(child, "close");
  await new Promise((resolve, reject) => {
    let diagnostic = "";
    const timer = setTimeout(() => reject(new Error()), 15000);
    child.stderr.on("data", (b) => {
      diagnostic = (diagnostic + b).slice(-4096);
      if (diagnostic.includes('"code":"LISTENING"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error());
    });
  });
  const smoke = spawn(
    process.execPath,
    ["scripts/smoke-mcp.mjs", "--url", url],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  smoke.stdout.on("data", (b) => {
    output += b;
  });
  smoke.stderr.resume();
  smoke.stdin.end(`${tokenFor(port)}\n`);
  const timeout = setTimeout(() => smoke.kill("SIGKILL"), 22000);
  const [code] = await once(smoke, "close");
  clearTimeout(timeout);
  if (
    code !== 0 ||
    !output.includes("MCP_SMOKE_PASS legacy") ||
    !output.includes("MCP_SMOKE_PASS modern")
  )
    throw new Error();
  for (const era of ["legacy", "modern"]) {
    for (const token of [
      undefined,
      await sign(url, { exp: Math.floor(Date.now() / 1000) - 1 }),
      await sign(url, { sub: "other-synthetic-owner" }),
    ]) {
      const client = new Client(
        { name: "negative-auth", version: "1" },
        {
          versionNegotiation: {
            mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
          },
        },
      );
      let failed = false;
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            },
            fetch: (u, o) =>
              fetch(u, {
                ...o,
                redirect: "error",
                signal: AbortSignal.timeout(3000),
              }),
          }),
        );
      } catch {
        failed = true;
      } finally {
        await client.close();
      }
      if (!failed) throw new Error();
    }
  }
  process.kill(-child.pid, "SIGTERM");
  await closed;
  child = undefined;
  console.log(`AUTH_FIXTURE_SMOKE_PASS ${mode}`);
} catch {
  console.error("AUTH_FIXTURE_SMOKE_FAILED");
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
