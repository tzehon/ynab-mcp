import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { serve } from "./helpers/server.mjs";
import { sign, tokenFor } from "./helpers/auth.mjs";

function raw(
  port,
  headers,
  method = "POST",
  body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ynab_list_plans","arguments":{}}}',
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (b) => {
          text += b;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("all rejected MCP requests stop before protocol and adapter, including duplicate headers", async (t) => {
  let protocol = 0,
    adapter = 0;
  const app = await serve(
    t,
    {},
    undefined,
    async () => {
      adapter++;
      throw new Error();
    },
    undefined,
    (request) => {
      protocol++;
      assert.equal(request.headers.get("authorization"), null);
    },
  );
  const valid = tokenFor(app.port);
  const badOwner = await sign(app.url, { sub: "SECRET_SUBJECT" });
  const insufficient = await sign(app.url, { scope: "" });
  const cases = [
    [{}, 401],
    [{ Authorization: "Bearer invalid" }, 401],
    [{ Authorization: [`Bearer ${valid}`, `Bearer ${valid}`] }, 401],
    [{ Authorization: `Bearer ${valid}, Bearer ${valid}` }, 401],
    [{ Authorization: `Bearer ${badOwner}` }, 403],
    [{ Authorization: `Bearer ${insufficient}` }, 403],
  ];
  for (const [headers, status] of cases) {
    const result = await raw(app.port, headers);
    assert.equal(result.status, status);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.ok(Buffer.byteLength(result.text) <= 2048);
    assert.ok(!result.text.includes(valid));
    assert.ok(!result.text.includes("SECRET_SUBJECT"));
  }
  for (const method of ["GET", "HEAD", "DELETE", "PUT", "OPTIONS"])
    assert.equal((await raw(app.port, {}, method)).status, 401);
  assert.equal((await raw(app.port, {}, "POST", "{invalid")).status, 401);
  assert.equal(
    (
      await raw(
        app.port,
        {},
        "POST",
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      )
    ).status,
    401,
  );
  assert.equal(protocol, 0);
  assert.equal(adapter, 0);
  const missing = await raw(app.port, {});
  assert.ok(!missing.headers["www-authenticate"].includes("invalid_token"));
  const denied = await raw(app.port, {
    Authorization: `Bearer ${insufficient}`,
  });
  assert.match(denied.headers["www-authenticate"], /insufficient_scope/);
  assert.equal(
    (await raw(app.port, { Authorization: `Bearer ${valid}` })).status,
    200,
  );
  assert.equal(protocol, 1);
  assert.equal(adapter, 0);
});

test("auth overload and disconnect do not block public health or dispatch late work", {
  timeout: 7000,
}, async (t) => {
  let protocol = 0,
    calls = 0,
    release;
  const app = await serve(
    t,
    {},
    undefined,
    undefined,
    async () => {
      calls++;
      await new Promise((r) => {
        release = r;
      });
      return { status: 200, contentType: "application/json", body: "{}" };
    },
    () => {
      protocol++;
    },
  );
  const header = { Authorization: `Bearer ${tokenFor(app.port)}` };
  const pending = Array.from({ length: 4 }, () => raw(app.port, header));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await raw(app.port, header)).status, 503);
  assert.equal((await fetch(new URL("/healthz", app.url))).status, 200);
  assert.ok((await Promise.all(pending)).every((r) => r.status === 503));
  assert.equal(calls, 1);
  assert.equal(protocol, 0);
  release();
  await new Promise((r) => setImmediate(r));
  await app.close();
  assert.equal(protocol, 0);
});
test("challenge discovers exact public metadata under strict host/origin policy", async (t) => {
  const app = await serve(t);
  const rejected = await raw(app.port, {}),
    challenge = rejected.headers["www-authenticate"];
  assert.match(challenge, /scope="ynab:read"/);
  const url = /resource_metadata="([^"]+)"/.exec(challenge)[1];
  assert.equal(
    new URL(url).pathname,
    "/.well-known/oauth-protected-resource/mcp",
  );
  const r = await fetch(url);
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.equal(doc.resource, app.url);
  assert.deepEqual(doc.scopes_supported, ["ynab:read"]);
  assert.deepEqual(doc.bearer_methods_supported, ["header"]);
  for (const method of ["HEAD", "OPTIONS"]) {
    const x = await fetch(url, {
      method,
      headers: { "Access-Control-Request-Headers": "SECRET_ARBITRARY" },
    });
    assert.equal(x.status, method === "HEAD" ? 200 : 204);
    assert.equal(await x.text(), "");
    assert.equal(x.headers.get("Access-Control-Allow-Origin"), null);
    assert.ok(!JSON.stringify([...x.headers]).includes("SECRET_ARBITRARY"));
  }
  assert.equal(
    (await fetch(url, { headers: { Origin: "https://evil.test" } })).status,
    403,
  );
  assert.equal(
    (await fetch(new URL("/.well-known/oauth-authorization-server", url)))
      .status,
    404,
  );
  assert.equal((await fetch(`${app.url}?access_token=SECRET`)).status, 404);
  const health = await fetch(new URL("/healthz", url), { method: "HEAD" });
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "");
});

test("disconnect cancels auth work without admitting a late protocol call", async (t) => {
  let entered,
    release,
    protocol = 0,
    aborted = false;
  const waiting = new Promise((r) => {
    entered = r;
  });
  const app = await serve(
    t,
    {},
    undefined,
    undefined,
    async (_request, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      entered();
      await new Promise((r) => {
        release = r;
      });
      return { status: 200, contentType: "application/json", body: "{}" };
    },
    () => {
      protocol++;
    },
  );
  const req = http.request(app.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor(app.port)}` },
  });
  req.on("error", () => {});
  req.end();
  await waiting;
  req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(aborted);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(protocol, 0);
  assert.equal((await fetch(new URL("/healthz", app.url))).status, 200);
});
