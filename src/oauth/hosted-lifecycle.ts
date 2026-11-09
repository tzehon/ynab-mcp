import { randomBytes } from "node:crypto";
import { fail } from "./crypto.js";
import type { HostedUpstream } from "./hosted-upstream.js";
import type { Connection } from "./lifecycle.js";
import type { Store } from "./store.js";
import type { Tokens } from "./upstream.js";

export class HostedLifecycle {
  private failed = false;
  constructor(
    private store: Store,
    private upstream: Pick<HostedUpstream, "refresh">,
    readonly owner: string,
  ) {
    if (this.current()?.status === "refreshing") this.disconnect();
  }
  private guard<T>(fn: () => T) {
    if (this.failed) fail();
    try {
      return fn();
    } catch {
      this.failed = true;
      return fail();
    }
  }
  current() {
    return this.guard(
      () => this.store.get("Connection", this.owner) as Connection | undefined,
    );
  }
  ready() {
    this.current();
  }
  generation() {
    return this.current()?.generation;
  }
  connect(tokens: Tokens, owner: string) {
    if (owner !== this.owner || tokens.expires <= this.store.now()) fail();
    return this.guard(() =>
      this.store.transaction(() => {
        const existing = this.current();
        if (existing?.status === "refreshing") fail();
        const next: Connection = {
          generation:
            existing?.generation ?? randomBytes(32).toString("base64url"),
          status: "active",
          tokens,
        };
        this.store.put("Connection", this.owner, next, Number.MAX_SAFE_INTEGER);
        return next;
      }),
    );
  }
  check() {
    const c = this.current();
    if (c?.status !== "active" || c.tokens.expires <= this.store.now()) fail();
  }
  disconnect() {
    this.guard(() => this.store.clearHostedAuthorization());
  }
  async refresh() {
    let snapshot: Connection | undefined;
    const operation = randomBytes(32).toString("base64url");
    this.guard(() =>
      this.store.transaction(() => {
        const c = this.current();
        if (!c) fail();
        if (
          c.status === "refreshing" ||
          c.tokens.expires > this.store.now() + 60000
        )
          return;
        snapshot = c;
        this.store.put(
          "Connection",
          this.owner,
          { ...c, status: "refreshing", operation },
          Number.MAX_SAFE_INTEGER,
          {},
          true,
        );
      }),
    );
    if (!snapshot) {
      for (let i = 0; i < 160; i++) {
        const c = this.current();
        if (!c) fail();
        if (c.status === "active") return;
        await new Promise((r) => setTimeout(r, 20));
      }
      this.disconnect();
      return fail();
    }
    try {
      const tokens = await this.upstream.refresh(snapshot.tokens);
      const saved = this.guard(() =>
        this.store.transaction(() => {
          const current = this.current();
          if (
            current?.operation !== operation ||
            current.generation !== snapshot?.generation
          )
            return false;
          this.store.put(
            "Connection",
            this.owner,
            { generation: current.generation, status: "active", tokens },
            Number.MAX_SAFE_INTEGER,
            {},
            true,
          );
          return true;
        }),
      );
      if (!saved) fail();
    } catch {
      // Do not retry a provider refresh whose outcome may be ambiguous.
      if (!this.failed && this.current()?.operation === operation)
        this.disconnect();
      return fail();
    }
  }
}
