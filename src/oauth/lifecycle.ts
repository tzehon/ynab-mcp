import { randomBytes } from "node:crypto";
import { fail } from "./crypto.js";
import type { RecordValue, Store } from "./store.js";
import type { Tokens, Upstream } from "./upstream.js";
export const random = () => randomBytes(32).toString("base64url");
export type Connection = RecordValue & {
  generation: string;
  status: "active" | "refreshing";
  tokens: Tokens;
};
export class Lifecycle {
  constructor(
    private store: Store,
    private upstream: Pick<Upstream, "refresh">,
    private owner: string,
  ) {
    if (this.current()?.status === "refreshing") this.disconnect();
  }
  current() {
    return this.store.get("Connection", this.owner) as Connection | undefined;
  }
  connect(tokens: Tokens) {
    const existing = this.current();
    if (existing?.status === "refreshing") fail();
    const c: Connection = {
      generation: existing?.generation ?? random(),
      status: "active",
      tokens,
    };
    this.store.put("Connection", this.owner, c, Number.MAX_SAFE_INTEGER);
    return c;
  }
  checkGrant(claims: Record<string, unknown>) {
    if (typeof claims.grant_id !== "string") fail();
    const g = this.store.get("McpGrant", claims.grant_id as string),
      c = this.current();
    if (
      !g ||
      !c ||
      c.status !== "active" ||
      g.generation !== c.generation ||
      g.owner !== this.owner ||
      claims.sub !== this.owner ||
      g.client !== claims.client_id
    )
      fail();
  }
  disconnect() {
    this.store.clearAuthorization();
  }
  async refresh() {
    const token = random();
    let snapshot: Connection | undefined;
    this.store.transaction(() => {
      const c = this.current();
      if (!c) fail();
      if (c.status === "refreshing") return;
      if (c.tokens.expires > this.store.now()) return;
      snapshot = c;
      this.store.put(
        "Connection",
        this.owner,
        { ...c, status: "refreshing", operation: token },
        Number.MAX_SAFE_INTEGER,
        {},
        true,
      );
    });
    if (!snapshot) {
      for (let i = 0; i < 150; i++) {
        const c = this.current();
        if (!c) fail();
        if (c.status === "active") return;
        await new Promise((r) => setTimeout(r, 20));
      }
      return fail();
    }
    const expectedGeneration = snapshot.generation;
    try {
      const tokens = await this.upstream.refresh(snapshot.tokens);
      this.store.transaction(() => {
        const c = this.current();
        if (!c || c.operation !== token || c.generation !== expectedGeneration)
          fail();
        this.store.put(
          "Connection",
          this.owner,
          { generation: c.generation, status: "active", tokens },
          Number.MAX_SAFE_INTEGER,
          {},
          true,
        );
      });
    } catch {
      this.store.transaction(() => {
        if (this.current()?.operation === token) this.disconnect();
      });
      return fail();
    }
  }
}
