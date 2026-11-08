import type { JSONWebKeySet } from "jose";
import { DISCOVERY, ISSUER, JWKS } from "./config.js";
import { invalid } from "./errors.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function discovery(value: unknown) {
  const d = record(value);
  if (d.issuer !== ISSUER || d.jwks_uri !== JWKS) invalid();
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (typeof d[key] !== "string") invalid();
    let url: URL;
    try {
      url = new URL(d[key]);
    } catch {
      return invalid();
    }
    if (
      url.origin !== new URL(ISSUER).origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== d[key]
    )
      invalid();
  }
  for (const [key, needed] of [
    ["response_types_supported", "code"],
    ["code_challenge_methods_supported", "S256"],
  ] as const) {
    const list = d[key];
    if (
      !Array.isArray(list) ||
      list.length > 32 ||
      list.some((x) => typeof x !== "string") ||
      !list.includes(needed)
    )
      invalid();
  }
  return d;
}
export function keySet(value: unknown): JSONWebKeySet {
  const set = record(value);
  if (!Array.isArray(set.keys) || set.keys.length < 1 || set.keys.length > 8)
    invalid();
  const ids = new Set<string>();
  for (const entry of set.keys) {
    const k = record(entry);
    if (
      k.kty !== "RSA" ||
      k.alg !== "RS256" ||
      k.use !== "sig" ||
      typeof k.kid !== "string" ||
      !/^[\x21-\x7e]{1,128}$/.test(k.kid) ||
      ids.has(k.kid)
    )
      invalid();
    ids.add(k.kid);
    if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((name) => name in k))
      invalid();
    if (
      k.key_ops !== undefined &&
      (!Array.isArray(k.key_ops) ||
        k.key_ops.length !== 1 ||
        k.key_ops[0] !== "verify")
    )
      invalid();
    if (
      typeof k.n !== "string" ||
      typeof k.e !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(k.n) ||
      !/^[A-Za-z0-9_-]+$/.test(k.e)
    )
      invalid();
    const n = Buffer.from(k.n, "base64url");
    const e = Buffer.from(k.e, "base64url");
    if (
      n.toString("base64url") !== k.n ||
      e.toString("base64url") !== k.e ||
      !n[0] ||
      !e[0] ||
      e.length > 8
    )
      invalid();
    const bits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]));
    if (bits < 2048 || bits > 4096) invalid();
  }
  return set as unknown as JSONWebKeySet;
}
export type AuthReply = { status: number; contentType: string; body: string };
export type AuthTransport = (
  request: Readonly<{ method: "GET"; url: string }>,
  signal: AbortSignal,
) => Promise<AuthReply>;
export function decode(reply: AuthReply): unknown {
  if (
    reply.status !== 200 ||
    reply.contentType !== "application/json" ||
    typeof reply.body !== "string" ||
    Buffer.byteLength(reply.body) > 65536
  )
    invalid();
  try {
    return JSON.parse(reply.body);
  } catch {
    return invalid();
  }
}
export function fixtureTransport(bundle: {
  discovery: unknown;
  jwks: unknown;
}): AuthTransport {
  const docs = new Map([
    [DISCOVERY, JSON.stringify(bundle.discovery)],
    [JWKS, JSON.stringify(bundle.jwks)],
  ]);
  return async (request, signal) => {
    signal.throwIfAborted();
    const body = docs.get(request.url);
    if (request.method !== "GET" || body === undefined) invalid();
    return { status: 200, contentType: "application/json", body };
  };
}
