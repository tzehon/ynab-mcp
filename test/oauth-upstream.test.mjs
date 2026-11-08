import assert from "node:assert/strict";
import test from "node:test";
import { Upstream } from "../dist/oauth/upstream.js";

const config = {
  upstream: "http://127.0.0.1:5555",
  origin: "http://127.0.0.1:4444",
  upstreamSecret: "synthetic",
  owner: "11111111-1111-4111-8111-111111111111",
};
const previous = { access: "old", refresh: "refresh-canary", expires: 1 };
function reply(
  body,
  status = 200,
  headers = { "content-type": "application/json" },
) {
  return new Response(JSON.stringify(body), { status, headers });
}
test("malformed, oversized, wrong-scope, redirect and failed refresh responses are rejected", async () => {
  for (const r of [
    reply({}),
    reply({
      access_token: "new",
      token_type: "bearer",
      expires_in: -1,
      refresh_token: "new",
    }),
    reply({
      access_token: "new",
      token_type: "bearer",
      expires_in: 60,
      scope: "write",
      refresh_token: "new",
    }),
    reply({
      access_token: "x".repeat(70000),
      token_type: "bearer",
      expires_in: 60,
    }),
    reply({}, 302, {
      location: "https://example.invalid",
      "content-type": "application/json",
    }),
    reply({ error: "invalid_grant" }, 400),
  ]) {
    const u = new Upstream(config, async () => r);
    await assert.rejects(u.refresh(previous));
    u.close();
  }
});
test("control-plane concurrency is bounded; cancellation closes pending fetches", async () => {
  let calls = 0;
  const u = new Upstream(
    config,
    (_url, init) =>
      new Promise((_r, reject) => {
        calls++;
        init.signal.addEventListener("abort", () =>
          reject(Error("secret-canary")),
        );
      }),
  );
  const tasks = Array.from({ length: 4 }, () => u.refresh(previous));
  const pending = Promise.allSettled(tasks);
  await assert.rejects(u.refresh(previous));
  assert.equal(calls, 4);
  u.close();
  assert((await pending).every((r) => r.status === "rejected"));
});
test("upstream per-call deadline aborts a stuck transport without leaking its error", async () => {
  const u = new Upstream(
    config,
    (_url, init) =>
      new Promise((_r, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(Error("secret-canary")),
        ),
      ),
  );
  await assert.rejects(
    u.refresh(previous),
    (e) => e.message === "OAUTH_REJECTED",
  );
  u.close();
});
