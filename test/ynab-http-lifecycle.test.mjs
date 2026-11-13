import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHttpTransport } from "../dist/ynab/http-transport.js";
import { mapped, bearer, request, code } from "./helpers/ynab-http.mjs";

test("ready empty streams yield so caller abort runs without retaining empty chunks", {
  timeout: 3000,
}, async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(0));
    },
    cancel() {
      cancelled++;
    },
  });
  const transport = createHttpTransport({
    allowedMappedIds: [mapped],
    accessToken: async () => bearer,
    fetcher: async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    transport(request(), AbortSignal.timeout(30)),
    code("UPSTREAM_TIMEOUT"),
  );
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("malformed configuration accessors and non-byte stream chunks expose only fixed errors", async () => {
  assert.throws(
    () =>
      createHttpTransport({
        get accessToken() {
          throw Error("CONFIG_CANARY");
        },
      }),
    code("INVALID_ARGUMENTS"),
  );
  const body = new ReadableStream({
    start(c) {
      c.enqueue("BODY_CANARY");
    },
    cancel() {
      throw Error("CANCEL_CANARY");
    },
  });
  const transport = createHttpTransport({
    allowedMappedIds: [mapped],
    accessToken: async () => bearer,
    fetcher: async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    transport(request(), new AbortController().signal),
    code("UPSTREAM_INVALID_RESPONSE"),
  );
  assert.equal(body.locked, false);
});

test("compiled application graph has no HTTP budget transport dependency", () => {
  const seen = new Set();
  function walk(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g,
    ))
      walk(resolve(dirname(path), match[1]));
  }
  walk(resolve("dist/main.js"));
  assert.ok(seen.size > 10);
  assert.ok(!seen.has(resolve("dist/ynab/http-transport.js")));
  assert.ok(!seen.has(resolve("dist/ynab/http-request.js")));
  walk(resolve("dist/ynab/http-transport.js"));
  assert.ok(seen.has(resolve("dist/ynab/http-request.js")));
});
