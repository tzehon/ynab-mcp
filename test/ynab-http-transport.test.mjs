import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createHttpTransport } from "../dist/ynab/http-transport.js";
import { MAX_BODY } from "../dist/ynab/contracts.js";
import { MockYnabClient } from "../dist/ynab/client.js";
import { AdmissionBudget } from "../dist/ynab/limits.js";
import { parseConfig } from "../dist/config.js";
import { fixtureEnv } from "./helpers/auth.mjs";
import { listAccounts } from "../dist/tools/list-accounts.js";
import {
  mapped,
  other,
  bearer,
  request,
  code,
  tick,
  deferred,
} from "./helpers/ynab-http.mjs";

const ok = () =>
  new Response('{"data":{"accounts":[],"server_knowledge":1}}', {
    headers: { "content-type": "application/json" },
  });
const setup = (options = {}) =>
  createHttpTransport({
    allowedMappedIds: [mapped],
    accessToken: async () => bearer,
    fetcher: async () => ok(),
    ...options,
  });
const run = (
  transport,
  value = request(),
  signal = new AbortController().signal,
) => transport(value, signal);
const client = (transport) =>
  new MockYnabClient(parseConfig(fixtureEnv), transport, new AdmissionBudget());
const call = (c, signal) =>
  listAccounts(c, { plan_id: "fixture-plan-sgd" }, signal);

test("HTTP transport has mandatory injection, private copied allowlist and no mutable options", async () => {
  for (const options of [
    undefined,
    {},
    { allowedMappedIds: [] },
    { allowedMappedIds: ["bad"], accessToken() {}, fetcher() {} },
  ])
    assert.throws(
      () => createHttpTransport(options),
      code("INVALID_ARGUMENTS"),
    );
  for (const allowedMappedIds of [undefined, {}, [null], [mapped + "\n"]])
    assert.throws(() => setup({ allowedMappedIds }), code("INVALID_ARGUMENTS"));
  const ids = [mapped],
    opts = {
      allowedMappedIds: ids,
      accessToken: async () => bearer,
      fetcher: async () => ok(),
    };
  const transport = createHttpTransport(opts);
  ids.push(other);
  opts.fetcher = () => {
    throw Error("MUTATED_CANARY");
  };
  assert.equal((await run(transport)).status, 200);
  await assert.rejects(
    run(transport, { ...request(), path: `/v1/plans/${other}/accounts` }),
    code("PLAN_NOT_ALLOWED"),
  );
  await assert.rejects(
    run(setup({ allowedMappedIds: [] })),
    code("PLAN_NOT_ALLOWED"),
  );
  await assert.rejects(transport(request()), code("INVALID_ARGUMENTS"));
});

test("invalid descriptors and disallowed direct mapped IDs never acquire credentials or fetch", async () => {
  let tokens = 0,
    fetches = 0;
  const transport = setup({
    accessToken: async () => {
      tokens++;
      return bearer;
    },
    fetcher: async () => {
      fetches++;
      return ok();
    },
  });
  const bad = [
    undefined,
    null,
    [],
    1,
    {},
    { ...request(), method: "POST" },
    { ...request(), headers: {} },
  ];
  for (const origin of [
    "http://api.ynab.com",
    "https://api.ynab.com/",
    "https://api.ynab.com:443",
    "https://API.YNAB.COM",
    "https://api.ynab.com.evil.test",
  ])
    bad.push({ ...request(), origin });
  for (const tail of [
    "ACCOUNTS",
    "accounts/",
    "accounts\n",
    "accounts?x=1",
    "accounts#x",
    "accounts\\x",
    "%61ccounts",
    "../accounts",
    "months/current",
    "months/2026-02-30",
    "months/2026-11-02",
    "months/1999-01-01",
    "months/2100-01-01",
  ])
    bad.push(request(tail));
  for (const query of [null, [], { limit: "1" }, { access_token: bearer }])
    bad.push(request("accounts", query));
  const dateQuery = { since_date: "2026-01-01", until_date: "2026-03-31" };
  for (const query of [
    {},
    { ...dateQuery, limit: "1" },
    { ...dateQuery, until_date: "2026-04-01" },
    { ...dateQuery, until_date: "2025-12-31" },
    { ...dateQuery, since_date: 1 },
    { ...dateQuery, since_date: "2026-02-30" },
  ])
    bad.push(request("transactions", query));
  bad.push(Object.create(request()), { ...request(), [Symbol("extra")]: 1 });
  bad.push(
    Object.defineProperty(request(), "path", {
      get() {
        throw Error("GETTER_CANARY");
      },
    }),
  );
  for (const value of bad)
    await assert.rejects(
      transport(value, new AbortController().signal),
      code("INVALID_ARGUMENTS"),
    );
  await assert.rejects(
    run(transport, { ...request(), path: `/v1/plans/${other}/accounts` }),
    code("PLAN_NOT_ALLOWED"),
  );
  await assert.rejects(
    run(transport, request(), AbortSignal.abort()),
    code("UPSTREAM_TIMEOUT"),
  );
  assert.deepEqual([tokens, fetches], [0, 0]);
});

test("all exact routes and date limits, immutable request snapshot and outgoing options", async () => {
  const queries = [
    { since_date: "2026-01-01", until_date: "2026-03-31" },
    { since_date: "2026-11-01", until_date: "2026-11-01" },
  ];
  for (const value of [
    request(),
    request("categories"),
    request("months/2024-02-01"),
    ...queries.map((q) => request("transactions", q)),
  ]) {
    const gate = deferred();
    let observed;
    const original = structuredClone(value);
    const transport = setup({
      allowedMappedIds: [mapped.toUpperCase()],
      accessToken: () => gate.promise,
      fetcher: async (url, init) => {
        observed = { url, init };
        return ok();
      },
    });
    const pending = run(transport, value);
    value.path = "/BAD";
    value.query.since_date = "BAD";
    gate.resolve(bearer);
    await pending;
    const query = new URLSearchParams(original.query).toString();
    assert.equal(
      observed.url,
      original.origin + original.path + (query ? `?${query}` : ""),
    );
    assert.deepEqual(Object.keys(observed.init).sort(), [
      "credentials",
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
    assert.deepEqual(observed.init.headers, {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
    });
    assert.equal(observed.init.redirect, "manual");
    assert.equal(observed.init.credentials, "omit");
    assert.equal(observed.init.method, "GET");
    assert.equal(observed.init.signal.aborted, true);
  }
});

test("token grammar and supplier failures are bounded, single-use and confidential", async () => {
  for (const token of [
    undefined,
    null,
    "",
    " ",
    "a\n",
    "a\r",
    "a b",
    "é",
    "a=b",
    "=",
    "x".repeat(8193),
  ]) {
    let fetches = 0;
    await assert.rejects(
      run(
        setup({
          accessToken: async () => token,
          fetcher: () => {
            fetches++;
          },
        }),
      ),
      code("UPSTREAM_UNAUTHORIZED"),
    );
    assert.equal(fetches, 0);
  }
  for (const token of ["a", "A0-._~+/==", "x".repeat(8192)])
    await run(setup({ accessToken: async () => token }));
  await assert.rejects(
    run(
      setup({
        accessToken: async () => {
          throw Error("TOKEN_CANARY");
        },
      }),
    ),
    code("UPSTREAM_UNAUTHORIZED"),
  );
  let calls = 0;
  const c = client(
    setup({
      accessToken: async () => {
        calls++;
        return bearer;
      },
      fetcher: async () => new Response("BODY_CANARY", { status: 401 }),
    }),
  );
  await assert.rejects(call(c), code("UPSTREAM_UNAUTHORIZED"));
  assert.equal(calls, 1);
  c.close();
});

test("body caps count bytes, accept exact cap and reject overrun before copying", async () => {
  for (const chunks of [
    [new Uint8Array(MAX_BODY)],
    [new Uint8Array(1), new Uint8Array(MAX_BODY - 1)],
  ]) {
    const response = new Response(
      new ReadableStream({
        start(c) {
          for (const b of chunks) c.enqueue(b);
          c.close();
        },
      }),
      {
        headers: {
          "content-type": "Application/JSON; charset=utf-8",
          "content-length": "1",
        },
      },
    );
    const result = await run(setup({ fetcher: async () => response }));
    let size = 0;
    for await (const chunk of result.body) size += chunk.byteLength;
    assert.equal(size, MAX_BODY);
    assert.equal(response.body.locked, false);
  }
  for (const chunks of [
    [new Uint8Array(MAX_BODY + 1)],
    [new Uint8Array(MAX_BODY), new Uint8Array(1)],
  ]) {
    let cancelled = 0,
      copiedOverrun = false;
    const last = chunks.at(-1);
    last.slice = () => {
      copiedOverrun = true;
      throw Error("OVERSIZE_CANARY");
    };
    const response = new Response(
      new ReadableStream({
        start(c) {
          for (const b of chunks) c.enqueue(b);
        },
        cancel() {
          cancelled++;
        },
      }),
      {
        headers: { "content-type": "application/json", "content-length": "0" },
      },
    );
    await assert.rejects(
      run(setup({ fetcher: async () => response })),
      code("UPSTREAM_RESPONSE_TOO_LARGE"),
    );
    assert.equal(cancelled, 1);
    assert.equal(copiedOverrun, false);
    assert.equal(response.body.locked, false);
  }
});

test("non-200 bodies are disposed unread; status mapping and malformed response errors are safe", async () => {
  for (const [status, expected] of [
    [201, "UPSTREAM_FAILURE"],
    [301, "UPSTREAM_FAILURE"],
    [302, "UPSTREAM_FAILURE"],
    [303, "UPSTREAM_FAILURE"],
    [307, "UPSTREAM_FAILURE"],
    [308, "UPSTREAM_FAILURE"],
    [400, "UPSTREAM_FAILURE"],
    [401, "UPSTREAM_UNAUTHORIZED"],
    [403, "UPSTREAM_FORBIDDEN"],
    [404, "NOT_FOUND"],
    [429, "UPSTREAM_RATE_LIMITED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [599, "UPSTREAM_UNAVAILABLE"],
  ]) {
    let reads = 0,
      cancels = 0;
    const response = {
      status,
      redirected: false,
      body: {
        getReader() {
          reads++;
          throw Error("BODY_CANARY");
        },
        cancel() {
          cancels++;
          return Promise.reject(Error("CANCEL_CANARY"));
        },
      },
      headers: new Headers({
        location: "https://CANARY.test",
        "retry-after": "CANARY",
      }),
    };
    const c = client(setup({ fetcher: async () => response }));
    await assert.rejects(call(c), code(expected));
    assert.equal(reads, 0);
    assert.equal(cancels, 1);
    c.close();
  }
  for (const response of [
    null,
    {},
    { status: 199 },
    { status: 600 },
    { status: 200.5 },
    { status: 200, redirected: true },
    new Response("CANARY"),
    new Response(null, { headers: { "content-type": "application/json" } }),
  ])
    await assert.rejects(
      run(setup({ fetcher: async () => response })),
      code("UPSTREAM_INVALID_RESPONSE"),
    );
  const locked = ok();
  const reader = locked.body.getReader();
  await assert.rejects(
    run(setup({ fetcher: async () => locked })),
    code("UPSTREAM_INVALID_RESPONSE"),
  );
  reader.releaseLock();
  await assert.rejects(
    run(
      setup({
        fetcher: async () => {
          throw Error("FETCH_CANARY");
        },
      }),
    ),
    code("UPSTREAM_FAILURE"),
  );
  const broken = new Response(
    new ReadableStream({
      pull() {
        throw Error("READ_CANARY");
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    run(setup({ fetcher: async () => broken })),
    code("UPSTREAM_FAILURE"),
  );
});

test("consumer retains strict UTF-8/JSON/schema/cardinality and public plan checks", async () => {
  for (const body of [
    new Uint8Array([255]),
    '{"data":',
    '{"data":{}}',
    JSON.stringify({
      data: { accounts: Array(201).fill({}), server_knowledge: 1 },
    }),
  ]) {
    const c = client(
      setup({
        fetcher: async () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
      }),
    );
    await assert.rejects(
      call(c),
      code(
        typeof body === "string" && body.length > 100
          ? "UPSTREAM_RESPONSE_TOO_LARGE"
          : "UPSTREAM_INVALID_RESPONSE",
      ),
    );
    c.close();
  }
  let hits = 0;
  const c = client(
    setup({
      accessToken: async () => {
        hits++;
        return bearer;
      },
    }),
  );
  await assert.rejects(
    listAccounts(c, { plan_id: "fixture-plan-usd" }),
    code("PLAN_NOT_ALLOWED"),
  );
  assert.equal(hits, 0);
  c.close();
});

test("abort at supplier/fetch/body settles promptly and removes listeners; late work is disposed", async () => {
  for (const phase of ["supplier", "fetch", "body"]) {
    const gate = deferred(),
      controller = new AbortController();
    let fetches = 0,
      cancelled = 0;
    const response = new Response(
      new ReadableStream({
        pull() {
          return gate.promise;
        },
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const transport = setup({
      accessToken: () =>
        phase === "supplier" ? gate.promise : Promise.resolve(bearer),
      fetcher: () => {
        fetches++;
        return phase === "fetch" ? gate.promise : Promise.resolve(response);
      },
    });
    const pending = run(transport, request(), controller.signal);
    await tick();
    controller.abort();
    await assert.rejects(pending, code("UPSTREAM_TIMEOUT"));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    gate.resolve(phase === "supplier" ? bearer : response);
    await tick();
    if (phase === "supplier") assert.equal(fetches, 0);
    else assert.equal(cancelled, 1);
    if (phase === "body") assert.equal(response.body.locked, false);
  }
});

test("one process budget admits four and rejects fifth; cancellation and client close recover capacity", async () => {
  const gates = [],
    budget = new AdmissionBudget();
  let tokens = 0;
  const transport = setup({
    accessToken: async () => {
      tokens++;
      const d = deferred();
      gates.push(d);
      return d.promise;
    },
  });
  const c = new MockYnabClient(parseConfig(fixtureEnv), transport, budget);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((a) => call(c, a.signal).catch((e) => e));
  await tick();
  await assert.rejects(call(c), code("BUSY"));
  assert.equal(tokens, 4);
  controllers[0].abort();
  c.close();
  for (const p of pending) assert.equal((await p).code, "UPSTREAM_TIMEOUT");
  for (const gate of gates) gate.resolve(bearer);
  await tick();
  const next = new MockYnabClient(parseConfig(fixtureEnv), setup(), budget);
  assert.equal((await call(next)).structuredContent.accounts.length, 0);
  next.close();
});

test("one three-second deadline spans supplier and fetch, not a fresh timer per phase", {
  timeout: 6000,
}, async () => {
  let fetched = false;
  const c = client(
    setup({
      accessToken: async () => {
        await new Promise((r) => setTimeout(r, 1600));
        return bearer;
      },
      fetcher: () => {
        fetched = true;
        return new Promise(() => {});
      },
    }),
  );
  const start = performance.now();
  await assert.rejects(call(c), code("UPSTREAM_TIMEOUT"));
  const elapsed = performance.now() - start;
  assert.ok(fetched);
  assert.ok(elapsed >= 2800 && elapsed < 4200, `elapsed ${elapsed}`);
  c.close();
});
