import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { DISCOVERY, JWKS } from "./config.js";
import { decode, discovery, keySet, type AuthTransport } from "./contracts.js";
import { AuthError, invalid } from "./errors.js";

export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AuthError("unavailable"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
type CachedKeys = {
  value: JSONWebKeySet;
  resolve: ReturnType<typeof createLocalJWKSet>;
  at: number;
};
type Refresh = {
  controller: AbortController;
  waiters: number;
  work: Promise<void>;
};
export class KeyStore {
  private metadataAt = -Infinity;
  private keys?: CachedKeys;
  private nextRefresh = -Infinity;
  private pending?: Refresh;
  private closed = false;
  constructor(
    private readonly transport: AuthTransport,
    private readonly now = () => performance.now(),
  ) {}
  async resolve(kid: string, signal: AbortSignal) {
    if (this.closed || signal.aborted) throw new AuthError("unavailable");
    const fresh = this.keys && this.now() - this.keys.at < 60000;
    if (fresh && this.keys?.value.keys.some((k) => k.kid === kid))
      return this.keys.resolve;
    if (!this.pending) {
      if (this.now() < this.nextRefresh) invalid();
      this.nextRefresh = this.now() + 5000;
      const controller = new AbortController();
      const pending: Refresh = {
        controller,
        waiters: 0,
        work: Promise.resolve(),
      };
      this.pending = pending;
      const timer = setTimeout(() => controller.abort(), 2000);
      pending.work = (async () => {
        const fetchDoc = async (url: string) => {
          const r = await this.transport(
            { method: "GET", url },
            controller.signal,
          );
          controller.signal.throwIfAborted();
          return decode(r);
        };
        let newMetadataAt: number | undefined;
        if (this.now() - this.metadataAt >= 60000) {
          discovery(await fetchDoc(DISCOVERY));
          newMetadataAt = this.now();
        }
        const value = keySet(await fetchDoc(JWKS));
        if (
          this.closed ||
          controller.signal.aborted ||
          this.pending !== pending
        )
          throw new AuthError("unavailable");
        this.keys = {
          value,
          resolve: createLocalJWKSet(value),
          at: this.now(),
        };
        if (newMetadataAt !== undefined) this.metadataAt = newMetadataAt;
      })().finally(() => {
        clearTimeout(timer);
        if (this.pending === pending) this.pending = undefined;
      });
      // The single physical refresh stays tracked even if its mock ignores abort.
      void pending.work.catch(() => {});
    }
    const pending = this.pending;
    pending.waiters++;
    try {
      await abortable(
        pending.work,
        AbortSignal.any([signal, pending.controller.signal]),
      );
    } finally {
      pending.waiters--;
      if (pending.waiters === 0 && this.pending === pending)
        pending.controller.abort();
    }
    if (signal.aborted || this.closed) throw new AuthError("unavailable");
    if (
      !this.keys ||
      this.now() - this.keys.at >= 60000 ||
      !this.keys.value.keys.some((k) => k.kid === kid)
    )
      invalid();
    return this.keys.resolve;
  }
  close() {
    this.closed = true;
    this.pending?.controller.abort();
  }
}
