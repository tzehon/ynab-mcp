import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dns from "node:dns";
import { createHttpTransport } from "../dist/ynab/http-transport.js";
import { MockYnabClient } from "../dist/ynab/client.js";
import { AdmissionBudget } from "../dist/ynab/limits.js";
import { parseConfig } from "../dist/config.js";
import { fixtureTransport, fixtureDocuments } from "../dist/fixtures/ynab.js";
import { listAccounts } from "../dist/tools/list-accounts.js";
import { getMonth } from "../dist/tools/get-month.js";
import { listCategories } from "../dist/tools/list-categories.js";
import { listTransactions } from "../dist/tools/list-transactions.js";
import { listPlans } from "../dist/tools/list-plans.js";
import { fixtureEnv } from "./helpers/auth.mjs";
import { guardLoopback } from "./helpers/ynab-http-guard.mjs";
import {
  mapped,
  bearer,
  request,
  code,
  provider,
  loopbackFetcher,
  deferred,
} from "./helpers/ynab-http.mjs";

const plan_id = "fixture-plan-sgd";
const config = parseConfig(fixtureEnv);
const newClient = (transport) =>
  new MockYnabClient(config, transport, new AdmissionBudget());
const transport = (fetcher) =>
  createHttpTransport({
    allowedMappedIds: [mapped],
    accessToken: async () => bearer,
    fetcher,
  });

test("four tools preserve fixture semantics over actual loopback HTTP, list-plans makes no requests", async (t) => {
  const seen = [];
  const p = await provider(t, (req, res) => {
    seen.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    const tail = req.url.split("/")[4].split("?")[0];
    const key = tail === "months" ? "month" : tail;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fixtureDocuments[mapped][key]));
  });
  const denied = guardLoopback(t, [p.port]);
  const fetcher = loopbackFetcher(p.origin);
  assert.throws(
    () => fetcher("https://evil.example.test/", {}),
    /TEST_ORIGIN_DENIED/,
  );
  assert.throws(
    () => net.connect({ host: "203.0.113.1", port: 443 }),
    /TEST_NETWORK_DENIED/,
  );
  assert.throws(
    () => dns.lookup("external.example.test", () => {}),
    /TEST_NETWORK_DENIED/,
  );
  assert.equal(denied(), 2);
  const c = newClient(transport(fetcher)),
    control = newClient(fixtureTransport);
  t.after(() => {
    c.close();
    control.close();
  });
  assert.equal(listPlans(config).plans.length, 1);
  assert.equal(seen.length, 0);
  for (const [tool, args] of [
    [listAccounts, { plan_id }],
    [getMonth, { plan_id, month: "2026-11-01" }],
    [listCategories, { plan_id }],
    [
      listTransactions,
      { plan_id, since_date: "2026-11-01", until_date: "2026-11-07", limit: 1 },
    ],
  ]) {
    assert.deepEqual(await tool(c, args), await tool(control, args));
  }
  assert.equal(seen.length, 4);
  for (const item of seen) {
    assert.equal(item.method, "GET");
    assert.equal(item.authorization, `Bearer ${bearer}`);
    assert.equal(item.cookie, undefined);
    assert.ok(!item.url.includes(bearer));
    assert.ok(!item.url.includes("limit="));
  }
  assert.match(seen[3].url, /\?since_date=2026-11-01&until_date=2026-11-07$/);
});

test("manual redirects never hit a second loopback server or leak the synthetic bearer", async (t) => {
  let hits = 0,
    current = 302;
  const sentinel = await provider(t, (_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  const first = await provider(t, (_req, res) => {
    res.writeHead(current, {
      location: `${sentinel.origin}/sentinel`,
      "content-type": "text/plain",
    });
    res.end("BODY_CANARY");
  });
  guardLoopback(t, [first.port, sentinel.port]);
  const c = newClient(transport(loopbackFetcher(first.origin)));
  t.after(() => c.close());
  for (const status of [301, 302, 303, 307, 308]) {
    current = status;
    await assert.rejects(
      listAccounts(c, { plan_id }),
      code("UPSTREAM_FAILURE"),
    );
    assert.equal(hits, 0);
  }
});

for (const phase of ["headers", "body"])
  test(`actual ${phase} stall is aborted at the server and later calls recover`, {
    timeout: 5000,
  }, async (t) => {
    const arrived = deferred(),
      closed = deferred();
    let first = true;
    const p = await provider(t, (_req, res) => {
      if (!first) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(fixtureDocuments[mapped].accounts));
        return;
      }
      first = false;
      res.once("close", () => closed.resolve());
      if (phase === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":');
      }
      arrived.resolve();
    });
    guardLoopback(t, [p.port]);
    const c = newClient(transport(loopbackFetcher(p.origin)));
    t.after(() => c.close());
    const controller = new AbortController();
    const pending = listAccounts(c, { plan_id }, controller.signal);
    await arrived.promise;
    controller.abort();
    await assert.rejects(pending, code("UPSTREAM_TIMEOUT"));
    await closed.promise;
    assert.equal(
      (await listAccounts(c, { plan_id })).structuredContent.data_mode,
      "fixtures",
    );
  });

test("HTTP non-200 streaming error body is cancelled without waiting for completion", {
  timeout: 5000,
}, async (t) => {
  const closed = deferred();
  const p = await provider(t, (_req, res) => {
    res.once("close", () => closed.resolve());
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "9999",
    });
    res.write("BODY_CANARY");
  });
  guardLoopback(t, [p.port]);
  const c = newClient(transport(loopbackFetcher(p.origin)));
  t.after(() => c.close());
  await assert.rejects(
    listAccounts(c, { plan_id }),
    code("UPSTREAM_RATE_LIMITED"),
  );
  await closed.promise;
});

test("test remapping never accepts another actual destination", async () => {
  for (const url of [
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.1:1234/path",
    "http://user@127.0.0.1:1234",
  ])
    assert.throws(() => loopbackFetcher(url), /TEST_TARGET_DENIED/);
  const f = loopbackFetcher("http://127.0.0.1:1234");
  for (const url of [
    "http://api.ynab.com/v1",
    "https://api.ynab.com.evil.test/v1",
    "https://user@api.ynab.com/v1",
    "https://api.ynab.com/v1#x",
  ])
    assert.throws(() => f(url, {}), /TEST_ORIGIN_DENIED/);
  const t = transport(async () => {
    throw Error("UNEXPECTED_CANARY");
  });
  await assert.rejects(
    t(
      { ...request(), origin: "http://127.0.0.1:1234" },
      new AbortController().signal,
    ),
    code("INVALID_ARGUMENTS"),
  );
});
