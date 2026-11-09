import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { hostedApp } from "./helpers/hosted-app.mjs";

for (const bootstrap of [true, false]) {
  test(`static hosted pages preserve closed authority and state (enrollment=${bootstrap})`, async (t) => {
    const { h, seen, e, dir, owner, app } = await hostedApp(t, { bootstrap });
    const browser = new h.Browser();
    // SQLite shared-memory read marks may change on reads; database/WAL must not.
    const files = () =>
      Object.fromEntries(
        readdirSync(dir)
          .sort()
          .filter(
            (name) =>
              name !== "authorization.sqlite-shm" &&
              statSync(join(dir, name)).isFile(),
          )
          .map((name) => [
            name,
            createHash("sha256")
              .update(readFileSync(join(dir, name)))
              .digest("hex"),
          ]),
      );
    const before = files();
    // Host-spoof cases target the actual HTTP listener behind the TLS proxy.
    // Keep the positive public requests above real certificate-verified TLS.
    const hostile = (path, headers) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: app.server.address().port,
            path,
            headers: { host: new URL(h.origin).host, ...headers },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
    for (const path of ["/", "/privacy"]) {
      const get = await browser.fetch(path, {
        headers: {
          authorization: "Bearer invented-secret-canary",
          cookie: "__Host-ynab_owner=invented-cookie-canary",
        },
      });
      assert.equal(get.status, 200);
      assert.match(get.text, /<title>MCP Tools for YNAB<\/title>/);
      assert.match(get.text, /href="\/privacy"/);
      assert.match(get.headers["content-type"], /text\/html/);
      assert.equal(get.headers["set-cookie"], undefined);
      assert.match(get.headers["cache-control"], /no-store/);
      assert.match(
        get.headers["content-security-policy"],
        /default-src 'none'/,
      );
      assert.equal(get.headers["referrer-policy"], "no-referrer");
      for (const privateValue of [
        owner,
        h.origin,
        e.OAUTH_WEB_SECRET,
        e.YNAB_CLIENT_SECRET,
        e.OAUTH_NATIVE_CLIENT_ID,
        "invented-secret-canary",
        "invented-cookie-canary",
        "fixture-plan-sgd",
        e.OAUTH_KEY_BUNDLE,
      ]) {
        assert(!get.text.includes(privateValue));
      }
      const head = await browser.fetch(path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.text, "");
      assert.equal(
        head.headers["content-length"],
        String(Buffer.byteLength(get.text)),
      );
      assert.equal(head.headers["set-cookie"], undefined);
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const r = await browser.fetch(path, { method });
        assert.equal(r.status, 405);
        assert.equal(r.headers.allow, "GET, HEAD");
        assert.equal(r.headers["set-cookie"], undefined);
      }
      for (const headers of [
        { host: "attacker.example" },
        { host: "healthcheck.railway.app" },
        { origin: "https://attacker.example" },
        {
          host: "attacker.example",
          "x-forwarded-host": new URL(h.origin).host,
        },
      ])
        assert.equal(await hostile(path, headers), 403);
      assert.equal(
        (await browser.fetch(`${path}?code=invented-query-canary`)).status,
        403,
      );
    }
    assert.deepEqual(
      files(),
      before,
      "static pages must not write authorization state",
    );
    assert.deepEqual(seen, [], "static pages must not contact YNAB");
    assert.equal(browser.cookies.size, 0);
    assert.equal((await browser.fetch("/mcp")).status, bootstrap ? 403 : 401);
    assert((await browser.fetch("/connection")).status >= 400);
  });
}
