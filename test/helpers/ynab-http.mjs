import http from "node:http";
import { once } from "node:events";
import { ORIGIN } from "../../dist/ynab/transport.js";

export const mapped = "11111111-1111-4111-8111-111111111111";
export const other = "22222222-2222-4222-8222-222222222222";
export const bearer = "SYNTHETIC_BEARER_CANARY";
export const request = (tail = "accounts", query = {}) => ({
  method: "GET",
  origin: ORIGIN,
  path: `/v1/plans/${mapped}/${tail}`,
  query,
});
export const code = (expected) => (error) => {
  if (error.code !== expected || /CANARY/.test(String(error)) || error.cause)
    return false;
  return true;
};
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export async function provider(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const port = server.address().port;
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
export function loopbackFetcher(origin) {
  const target = new URL(origin);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw new Error("TEST_TARGET_DENIED");
  return (value, init) => {
    const url = new URL(value);
    if (
      !String(value).startsWith(`${ORIGIN}/`) ||
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("TEST_ORIGIN_DENIED");
    return fetch(`${target.origin}${url.pathname}${url.search}`, init);
  };
}
