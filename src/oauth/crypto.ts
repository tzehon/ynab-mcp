import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
export function fail(): never {
  throw new Error("OAUTH_REJECTED");
}
export function index(key: Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}
export function seal(key: Buffer, aad: string, value: unknown) {
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > 65536) fail();
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    nonce,
    cipher.update(raw),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
export function unseal(key: Buffer, aad: string, value: Uint8Array): unknown {
  try {
    const raw = Buffer.from(value);
    if (raw.length < 28 || raw.length > 65564) fail();
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(raw.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
    );
  } catch {
    return fail();
  }
}
