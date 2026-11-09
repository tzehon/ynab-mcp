import { randomBytes } from "node:crypto";
import { fail } from "./crypto.js";
import { ABSOLUTE_SECONDS, IDLE_SECONDS } from "./hosted-policy.js";
import type { RecordValue, Store } from "./store.js";

type Family = RecordValue & {
  id: string;
  client: string;
  owner: string;
  resource: string;
  generation: string;
  created: number;
  used: number;
  deadline: number;
  status: "pending" | "active" | "rotating" | "revoked";
  operation?: string;
  deliveryPending?: boolean;
};
export type Reservation = {
  family: string;
  operation: string;
  generation: string;
};

// All operations are short synchronous durable transactions. No provider I/O
// is performed in a transaction. A request is usable only after finalization.
export class RefreshFamilies {
  private failed = false;
  constructor(
    private store: Store,
    private currentGeneration: () => string | undefined,
  ) {
    this.guard(() => {
      for (const row of store.values("RefreshFamily")) {
        const f = row as Family;
        if (
          f.status === "rotating" ||
          f.status === "pending" ||
          f.deliveryPending
        )
          this.revoke(f.id);
      }
    });
  }
  private guard<T>(work: () => T) {
    if (this.failed) fail();
    try {
      return work();
    } catch {
      this.failed = true;
      return fail();
    }
  }
  private write(f: Family) {
    // Updates need the store's reserved capacity to revoke at normal capacity.
    this.store.put("RefreshFamily", f.id, f, f.deadline, {}, true);
  }
  create(id: string, client: string, owner: string, resource: string) {
    this.guard(() =>
      this.store.transaction(() => {
        const generation = this.currentGeneration();
        if (!generation || this.store.get("RefreshFamily", id)) fail();
        const now = this.store.now();
        const f: Family = {
          id,
          client,
          owner,
          resource,
          generation,
          created: now,
          used: now,
          deadline: now + ABSOLUTE_SECONDS * 1000,
          status: "pending",
        };
        this.store.put("RefreshFamily", id, f, f.deadline);
      }),
    );
  }
  get(id: string) {
    return this.store.get("RefreshFamily", id) as Family | undefined;
  }
  ready() {
    if (this.failed) fail();
  }
  reserve(
    id: string,
    client: string,
    owner: string,
    initial: boolean,
    consumed: boolean,
  ): Reservation {
    if (this.failed) fail();
    let result: Reservation | undefined;
    this.guard(() =>
      this.store.transaction(() => {
        const f = this.get(id),
          now = this.store.now();
        // A wrong client cannot mutate another client's state.
        if (!f || f.client !== client || f.owner !== owner) return;
        if (
          f.generation !== this.currentGeneration() ||
          consumed ||
          f.deliveryPending ||
          f.status !== (initial ? "pending" : "active") ||
          now >= f.used + IDLE_SECONDS * 1000 ||
          now >= f.deadline
        ) {
          this.write({ ...f, status: "revoked", operation: undefined });
          return;
        }
        const operation = randomBytes(32).toString("base64url");
        this.write({ ...f, status: "rotating", operation });
        result = { family: id, operation, generation: f.generation };
      }),
    );
    if (!result) fail();
    return result;
  }
  finish(op: Reservation, deliveryPending = false) {
    if (this.failed) fail();
    let ok = false;
    this.guard(() =>
      this.store.transaction(() => {
        const f = this.get(op.family),
          now = this.store.now();
        if (!f) return;
        if (
          f.status !== "rotating" ||
          f.operation !== op.operation ||
          f.generation !== op.generation ||
          f.generation !== this.currentGeneration() ||
          now >= f.deadline
        ) {
          this.write({ ...f, status: "revoked", operation: undefined });
          return;
        }
        this.write({
          ...f,
          status: "active",
          operation: deliveryPending ? op.operation : undefined,
          deliveryPending,
          used: now,
        });
        ok = true;
      }),
    );
    if (!ok) fail();
  }
  delivered(op: Reservation) {
    this.guard(() =>
      this.store.transaction(() => {
        const f = this.get(op.family);
        if (
          f?.status !== "active" ||
          !f.deliveryPending ||
          f.operation !== op.operation ||
          f.generation !== this.currentGeneration()
        )
          return;
        this.write({ ...f, deliveryPending: false, operation: undefined });
      }),
    );
  }
  allowCode(id: string, client: string, owner: string) {
    const f = this.guard(() => this.get(id));
    if (
      f?.status !== "pending" ||
      f.client !== client ||
      f.owner !== owner ||
      f.generation !== this.currentGeneration()
    )
      fail();
  }
  revoke(id: string) {
    this.guard(() =>
      this.store.transaction(() => {
        const f = this.get(id);
        if (f) this.write({ ...f, status: "revoked", operation: undefined });
      }),
    );
  }
  check(id: string, client: string, owner: string, resource: string) {
    if (this.failed) fail();
    const f = this.guard(() => this.get(id)),
      now = this.store.now();
    if (
      f?.status !== "active" ||
      f.deliveryPending ||
      f.client !== client ||
      f.owner !== owner ||
      f.resource !== resource ||
      f.generation !== this.currentGeneration() ||
      now >= f.deadline ||
      now >= f.used + IDLE_SECONDS * 1000
    )
      fail();
  }
}
