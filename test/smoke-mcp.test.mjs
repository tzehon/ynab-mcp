import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { parseTarget } from "../scripts/smoke-mcp.mjs";
import { serve } from "./helpers/server.mjs";
import { unusedPort } from "./helpers/process.mjs";

async function cli(url) {
  const p = spawn(process.execPath, ["scripts/smoke-mcp.mjs", "--url", url], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  p.stdout.on("data", (x) => (output += x));
  p.stderr.on("data", (x) => (output += x));
  const timeout = setTimeout(() => p.kill("SIGKILL"), 22000);
  const [code] = await once(p, "close");
  clearTimeout(timeout);
  return { code, output };
}
test("smoke target permits only exact canonical loopback endpoint", () => {
  assert.equal(parseTarget("http://127.0.0.1:3000/mcp").hostname, "127.0.0.1");
  for (const url of [
    "https://127.0.0.1:3000/mcp",
    "http://localhost:3000/mcp",
    "http://127.0.0.1:0/mcp",
    "http://127.0.0.1:65536/mcp",
    "http://127.0.0.1:03000/mcp",
    "http://127.0.0.1:3000/mcp?q=x",
    "http://user:SECRET_MARKER@127.0.0.1:3000/mcp",
    "http://127.0.0.1:3000/mcp#x",
    "http://127.1:3000/mcp",
    "http://2130706433:3000/mcp",
    "http://example.invalid/mcp",
  ])
    assert.throws(() => parseTarget(url), /INVALID_SMOKE_TARGET/);
});
test("smoke CLI succeeds for both eras without dumping fixture contents", async (t) => {
  const app = await serve(t),
    r = await cli(app.url);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /MCP_SMOKE_PASS legacy/);
  assert.match(r.output, /MCP_SMOKE_PASS modern/);
  assert.ok(!r.output.includes("Invented"));
  assert.ok(!r.output.includes("fixture-plan"));
});
test("smoke CLI rejects unreachable and invalid targets without echoing input", async () => {
  for (const url of [
    `http://127.0.0.1:${await unusedPort()}/mcp`,
    "http://SECRET_MARKER.invalid/mcp",
  ]) {
    const r = await cli(url);
    assert.equal(r.code, 1);
    assert.equal(r.output, "MCP_SMOKE_FAILED\n");
  }
});
test("smoke never follows redirects and rejects malformed protocol endpoints", async (t) => {
  let requests = 0;
  const s = createServer((_req, res) => {
    requests++;
    res.writeHead(302, { Location: "http://127.0.0.1:1/SECRET_MARKER" });
    res.end();
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  let r = await cli(`http://127.0.0.1:${s.address().port}/mcp`);
  assert.equal(r.code, 1);
  assert.equal(requests, 1);
  s.removeAllListeners("request");
  s.on("request", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"SECRET_MARKER":"invalid protocol"}');
  });
  r = await cli(`http://127.0.0.1:${s.address().port}/mcp`);
  assert.equal(r.code, 1);
  assert.equal(r.output, "MCP_SMOKE_FAILED\n");
});
test("smoke rejects a protocol-valid result with an invalid output schema", async (t) => {
  const app = await serve(t);
  let corrupted = 0;
  const [original] = app.server.listeners("request");
  app.server.removeAllListeners("request");
  app.server.on("request", (req, res) => {
    const end = res.end.bind(res);
    let buffered = "";
    res.write = (chunk, encoding, callback) => {
      buffered +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (typeof encoding === "function") encoding();
      else if (callback) callback();
      return true;
    };
    res.end = (chunk, ...args) => {
      chunk = buffered + (chunk ? String(chunk) : "");
      if (chunk) {
        const body = JSON.parse(String(chunk));
        if (body.result?.structuredContent) {
          corrupted++;
          body.result.structuredContent = {
            data_mode: "live",
            plans: [],
            truncated: false,
          };
          body.result.content = [
            {
              type: "text",
              text: JSON.stringify(body.result.structuredContent),
            },
          ];
          chunk = JSON.stringify(body);
        }
      }
      return end(chunk, ...args);
    };
    original(req, res);
  });
  const r = await cli(app.url);
  assert.equal(r.code, 1);
  assert.equal(r.output, "MCP_SMOKE_FAILED\n");
  assert.equal(corrupted, 1);
});
for (const accepted of [false, true])
  test(`smoke bounds ${accepted ? "accepted-but-unanswered" : "silent"} requests`, {
    timeout: 9000,
  }, async (t) => {
    const s = createServer((_req, res) => {
      if (accepted) {
        res.writeHead(202);
        res.end();
      }
    });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    t.after(() => {
      s.closeAllConnections();
      s.close();
    });
    const start = performance.now(),
      r = await cli(`http://127.0.0.1:${s.address().port}/mcp`);
    assert.equal(r.code, 1);
    assert.ok(performance.now() - start < 7000);
    assert.equal(r.output, "MCP_SMOKE_FAILED\n");
  });
