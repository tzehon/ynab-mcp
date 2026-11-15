import { ToolError } from "../tools/errors.js";

export const SNAPSHOT_TTL = 120000;
type Snapshot<T> = { value: T; started: number; expires: number };
type Pending<T> = {
  controller: AbortController;
  promise: Promise<Snapshot<T>>;
  waiters: number;
  checks: Set<() => void>;
};

/** Bounded process memory only. Callers validate data and authorization. */
export class AnalysisCache<T> {
  private entries = new Map<string, Snapshot<T>>();
  private pending = new Map<string, Pending<T>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private now = () => Date.now()) {}
  private remove(key: string) {
    this.entries.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }
  clear() {
    for (const key of this.entries.keys()) this.remove(key);
    for (const work of this.pending.values()) work.controller.abort();
    this.pending.clear();
  }
  async get(
    key: string,
    refresh: boolean,
    signal: AbortSignal | undefined,
    check: () => void,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<Snapshot<T> & { reused: boolean }> {
    check();
    if (signal?.aborted) throw new ToolError("UPSTREAM_TIMEOUT");
    for (const [k, v] of this.entries)
      if (v.expires <= this.now()) this.remove(k);
    if (refresh) this.remove(key);
    const hit = this.entries.get(key);
    if (hit) {
      check();
      return { ...structuredClone(hit), reused: true };
    }
    let task = this.pending.get(key);
    // A forced read never silently joins a snapshot that started before it.
    if (task && refresh) throw new ToolError("BUSY");
    const joined = !!task;
    if (!task) {
      if (this.pending.size >= 4) throw new ToolError("BUSY");
      const controller = new AbortController();
      const started = this.now();
      const next: Pending<T> = {
        controller,
        waiters: 0,
        checks: new Set(),
        promise: Promise.resolve()
          .then(async () => {
            if (controller.signal.aborted)
              throw new ToolError("UPSTREAM_TIMEOUT");
            const value = await work(controller.signal);
            if (controller.signal.aborted)
              throw new ToolError("UPSTREAM_TIMEOUT");
            // Caller-specific revocation must not poison valid co-waiters.
            // Retain a snapshot only if at least one active waiter is authorized.
            let authorized = false;
            for (const waiterCheck of next.checks) {
              try {
                waiterCheck();
                authorized = true;
              } catch {}
            }
            if (!authorized) throw new ToolError("UPSTREAM_UNAUTHORIZED");
            const snapshot = {
              value,
              started,
              expires: started + SNAPSHOT_TTL,
            };
            if (snapshot.expires > this.now()) {
              while (this.entries.size >= 4) {
                const oldest = this.entries.keys().next().value;
                if (oldest === undefined) break;
                this.remove(oldest);
              }
              this.entries.set(key, structuredClone(snapshot));
              const timer = setTimeout(
                () => this.remove(key),
                snapshot.expires - this.now(),
              );
              timer.unref();
              this.timers.set(key, timer);
            }
            return snapshot;
          })
          .finally(() => {
            if (this.pending.get(key) === next) this.pending.delete(key);
          }),
      };
      task = next;
      this.pending.set(key, task);
    }
    task.waiters++;
    const waiterCheck = () => check();
    task.checks.add(waiterCheck);
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new ToolError("UPSTREAM_TIMEOUT"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      const result = await Promise.race([task.promise, cancelled]);
      check();
      if (signal?.aborted) throw new ToolError("UPSTREAM_TIMEOUT");
      return { ...structuredClone(result), reused: joined };
    } finally {
      signal?.removeEventListener("abort", abort);
      task.checks.delete(waiterCheck);
      if (--task.waiters === 0 && this.pending.get(key) === task) {
        task.controller.abort();
        this.pending.delete(key);
      }
    }
  }
}
