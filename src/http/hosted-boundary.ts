import type { IncomingMessage } from "node:http";
import { fail } from "../oauth/crypto.js";

export function hostedBoundary(req: IncomingMessage, origin: string) {
  const target = req.url ?? "";
  if (
    target.length > 8192 ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /[^\x21-\x7e]/.test(target) ||
    /[\\#]/.test(target)
  )
    fail();
  const count = (name: string) =>
    req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name)
      .length;
  if (count("host") !== 1 || count("origin") > 1 || count("authorization") > 1)
    fail();
  const health =
    target === "/healthz" && ["GET", "HEAD"].includes(req.method ?? "");
  if (
    req.headers.host !== new URL(origin).host &&
    !(health && req.headers.host === "healthcheck.railway.app")
  )
    fail();
  for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
    const name = req.rawHeaders[i]?.toLowerCase() ?? "";
    if (name === "forwarded" || name.startsWith("x-forwarded-")) {
      req.rawHeaders.splice(i, 2);
      delete req.headers[name];
    }
  }
  // Only this validated boundary supplies the provider's offload scheme.
  req.headers["x-forwarded-proto"] = "https";
  req.rawHeaders.push("X-Forwarded-Proto", "https");
  return new URL(target, origin).pathname;
}
