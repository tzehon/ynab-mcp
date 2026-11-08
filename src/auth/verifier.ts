import { verifyBearerToken } from "@modelcontextprotocol/server";
import { decodeProtectedHeader, jwtVerify } from "jose";
import type { AuthConfig } from "./config.js";
import type { AuthTransport } from "./contracts.js";
import { AuthError, invalid } from "./errors.js";
import { abortable, KeyStore } from "./key-store.js";

// All server factories in this process share admission, including test instances.
let activeAuthentications = 0;

export class Authenticator {
  private readonly keys: Pick<KeyStore, "resolve" | "close">;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly config: AuthConfig,
    transport: AuthTransport,
    now?: () => number,
    private readonly date = () => new Date(),
    integrated?: {
      keys: Pick<KeyStore, "resolve" | "close">;
      grant: (claims: Record<string, unknown>) => void;
    },
  ) {
    this.keys = integrated?.keys ?? new KeyStore(transport, now);
    this.grant = integrated?.grant;
  }
  private readonly grant?: (claims: Record<string, unknown>) => void;
  async authenticate(
    header: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.closed || signal.aborted || activeAuthentications >= 4)
      throw new AuthError("unavailable");
    if (header === undefined) throw new AuthError("missing");
    if (
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(
        header,
      ) ||
      Buffer.byteLength(header.slice(7)) > 8192
    )
      invalid();
    activeAuthentications++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 2000);
    const work = (async () => {
      try {
        await verifyBearerToken(header, {
          requiredScopes: ["ynab:read"],
          expectedResource: new URL(this.config.audience),
          verifier: {
            verifyAccessToken: async (token) => {
              const h = decodeProtectedHeader(token);
              if (
                h.alg !== "RS256" ||
                !["at+jwt", "application/at+jwt"].includes(h.typ ?? "") ||
                typeof h.kid !== "string" ||
                !/^[\x21-\x7e]{1,128}$/.test(h.kid)
              )
                invalid();
              if (
                ["jku", "x5u", "jwk", "x5c", "crit", "b64"].some((k) => k in h)
              )
                invalid();
              const resolve = await this.keys.resolve(h.kid, combined);
              const { payload: p } = await jwtVerify(token, resolve, {
                algorithms: ["RS256"],
                typ: "at+jwt",
                issuer: this.config.issuer,
                audience: this.config.audience,
                clockTolerance: 0,
                currentDate: this.date(),
                requiredClaims: [
                  "iss",
                  "sub",
                  "aud",
                  "exp",
                  "iat",
                  "client_id",
                  "jti",
                ],
              });
              if (combined.aborted) throw new AuthError("unavailable");
              const time = this.date().getTime() / 1000;
              const integer = (v: unknown): v is number =>
                typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
              if (
                !integer(p.exp) ||
                !integer(p.iat) ||
                p.exp <= time ||
                p.iat > time ||
                p.exp <= p.iat
              )
                invalid();
              if (
                p.nbf !== undefined &&
                (!integer(p.nbf) || p.nbf > time || p.nbf >= p.exp)
              )
                invalid();
              for (const k of ["sub", "client_id", "jti"])
                if (
                  typeof p[k] !== "string" ||
                  !p[k].trim() ||
                  p[k].length > 256
                )
                  invalid();
              const aud = typeof p.aud === "string" ? [p.aud] : p.aud;
              if (
                !Array.isArray(aud) ||
                !aud.length ||
                aud.some((v) => typeof v !== "string" || !v) ||
                !aud.includes(this.config.audience)
              )
                invalid();
              if (
                p.scope !== undefined &&
                (typeof p.scope !== "string" ||
                  p.scope.length > 1024 ||
                  !/^[\x20-\x7e]*$/.test(p.scope))
              )
                invalid();
              if (p.sub !== this.config.subject) throw new AuthError("owner");
              const scopes =
                typeof p.scope === "string"
                  ? p.scope.split(" ").filter(Boolean)
                  : [];
              if (!scopes.includes("ynab:read")) throw new AuthError("scope");
              this.grant?.(p);
              // SDK's transient token-bearing value never leaves this auth boundary.
              return {
                token,
                clientId: p.client_id as string,
                scopes,
                expiresAt: p.exp,
                resource: new URL(this.config.audience),
              };
            },
          },
        });
        if (combined.aborted) throw new AuthError("unavailable");
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (combined.aborted) throw new AuthError("unavailable");
        return invalid();
      }
    })();
    void work
      .finally(() => {
        activeAuthentications--;
        this.controllers.delete(controller);
      })
      .catch(() => {});
    try {
      await abortable(work, combined);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
    this.keys.close();
  }
}
