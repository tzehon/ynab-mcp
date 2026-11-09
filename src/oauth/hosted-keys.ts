import { createPrivateKey, createPublicKey } from "node:crypto";
import type { JWK } from "jose";
import { fail } from "./crypto.js";
import type { Keys } from "./keys.js";

export type HostedKeys = Keys & { retiringUntil?: number };
export function hostedKeys(raw: string, now = Date.now()): HostedKeys {
  try {
    if (!raw || Buffer.byteLength(raw) > 32768) fail();
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) fail();
    const decode = (s: unknown) => {
      if (typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s)) fail();
      return Buffer.from(s as string, "hex");
    };
    const encryption = decode(v.encryption),
      lookup = decode(v.lookup),
      cookie = decode(v.cookie);
    if (
      encryption.equals(lookup) ||
      encryption.equals(cookie) ||
      lookup.equals(cookie)
    )
      fail();
    if (!Array.isArray(v.signing) || v.signing.length !== 1) fail();
    const signing = v.signing as JWK[],
      seen = new Set<string>();
    const validate = (k: JWK, privateKey: boolean) => {
      if (
        k?.kty !== "RSA" ||
        k.alg !== "RS256" ||
        k.use !== "sig" ||
        !k.kid ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(k.kid) ||
        seen.has(k.kid)
      )
        fail();
      seen.add(k.kid);
      if (
        privateKey
          ? !k.d
          : ["d", "p", "q", "dp", "dq", "qi", "oth"].some((p) => p in k)
      )
        fail();
      const key = privateKey
        ? createPrivateKey({ key: k, format: "jwk" })
        : createPublicKey({ key: k, format: "jwk" });
      if (
        key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        fail();
    };
    validate(signing[0] as JWK, true);
    if (v.retiring) {
      if (
        !Number.isSafeInteger(v.retiringUntil) ||
        v.retiringUntil <= now ||
        v.retiringUntil > now + 3600000
      )
        fail();
      validate(v.retiring, false);
      signing.push(v.retiring);
    } else if (v.retiringUntil !== undefined) fail();
    return {
      encryption,
      lookup,
      cookie: v.cookie,
      signing,
      retiringUntil: v.retiringUntil,
    };
  } catch {
    return fail();
  }
}
