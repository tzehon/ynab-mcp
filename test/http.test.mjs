import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { serve } from "./helpers/server.mjs";

function request(
  port,
  {
    path = "/mcp",
    method = "POST",
    headers = {},
    body = "",
    chunked = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (x) => (text += x));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("TEST_TIMEOUT")));
    if (chunked) {
      req.write(body.slice(0, 32768));
      req.end(body.slice(32768));
    } else req.end(body);
  });
}
test("HTTP health, route/method handling and exact Host/Origin enforcement", async (t) => {
  const { port } = await serve(t);
  assert.deepEqual(await request(port, { path: "/healthz", method: "GET" }), {
    status: 200,
    text: '{"status":"ok","data_mode":"fixtures"}',
  });
  assert.equal(
    (await request(port, { path: "/missing", method: "GET" })).status,
    404,
  );
  for (const method of ["GET", "DELETE", "PUT", "HEAD"])
    assert.equal((await request(port, { method })).status, 405);
  assert.equal(
    (await request(port, { path: "/healthz", method: "POST" })).status,
    405,
  );
  for (const Origin of [
    "https://example.invalid",
    "null",
    `http://127.0.0.1:${port + 1}`,
    `http://127.0.0.1.evil.test:${port}`,
    "SECRET_MARKER",
  ]) {
    const r = await request(port, {
      path: "/healthz",
      method: "GET",
      headers: { Origin },
    });
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes("SECRET_MARKER"));
  }
  for (const Host of [
    "localhost",
    `127.0.0.1:${port + 1}`,
    "127.0.0.1.evil.test",
    "SECRET_MARKER",
  ]) {
    const r = await request(port, {
      path: "/healthz",
      method: "GET",
      headers: {
        Host,
        "X-Forwarded-Host": `127.0.0.1:${port}`,
        Forwarded: `host=127.0.0.1:${port}`,
      },
    });
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes("SECRET_MARKER"));
  }
  assert.equal(
    (
      await request(port, {
        path: "/healthz",
        method: "GET",
        headers: { Origin: `http://127.0.0.1:${port}` },
      })
    ).status,
    200,
  );
});
test("HTTP errors are redacted; exact size limit and chunked oversize are enforced", async (t) => {
  const { port } = await serve(t);
  for (const body of [
    '{"SECRET_MARKER":',
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown_SECRET_MARKER" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ynab_list_plans", arguments: "SECRET_MARKER" },
    }),
  ]) {
    const r = await request(port, { body });
    assert.ok(!r.text.includes("SECRET_MARKER"));
    const value = JSON.parse(r.text);
    assert.ok(value.error || value.result?.isError);
    assert.ok(!r.text.includes("Invented Singapore"));
  }
  const version = await request(port, {
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    headers: { "MCP-Protocol-Version": "SECRET_MARKER" },
  });
  assert.equal(version.status, 400);
  assert.ok(!version.text.includes("SECRET_MARKER"));
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.equal((await request(port, { body: ping.padEnd(65536) })).status, 200);
  assert.equal(
    (
      await request(port, {
        body: ping.padEnd(65537),
        headers: { "Content-Length": "65537" },
      })
    ).status,
    413,
  );
  assert.equal(
    (await request(port, { body: ping.padEnd(65537), chunked: true })).status,
    413,
  );
  assert.equal(
    (await request(port, { path: "/healthz", method: "GET" })).status,
    200,
  );
});
test("incomplete headers and bodies are terminated within the ten-second bound", {
  timeout: 14000,
}, async (t) => {
  const { port } = await serve(t);
  await Promise.all(
    [
      "POST /mcp HTTP/1.1\r\nHost: ",
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{`,
    ].map(
      (prefix) =>
        new Promise((resolve, reject) => {
          const started = performance.now(),
            socket = net.connect(port, "127.0.0.1", () => socket.write(prefix));
          socket.resume();
          socket.on("error", () => {});
          socket.on("close", () => {
            clearInterval(trickle);
            clearTimeout(limit);
            try {
              assert.ok(performance.now() - started <= 11000);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
          const trickle = setInterval(() => socket.write(" "), 300); // Activity cannot extend a total deadline.
          const limit = setTimeout(() => {
            socket.destroy();
            reject(new Error("INCOMPLETE_REQUEST_NOT_BOUNDED"));
          }, 11000);
        }),
    ),
  );
});
