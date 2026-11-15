import { z } from "zod";
import type { Store } from "../oauth/store.js";
import { ToolError } from "../tools/errors.js";

const HOUR = 3600000;
const stateSchema = z.strictObject({
  attempts: z.array(z.number().int().nonnegative()).max(200),
  blockedUntil: z.number().int().nonnegative(),
});

/** One conservative owner-wide budget, retained across token rotation/restart.
 * Only timestamps are persisted, never tokens, URLs or financial data.
 */
export class RequestBudget {
  constructor(
    private store: Store,
    private owner: string,
  ) {}
  private read() {
    const raw = this.store.get("YnabRequestBudget", this.owner);
    const parsed = stateSchema.safeParse(
      raw ?? { attempts: [], blockedUntil: 0 },
    );
    if (!parsed.success) throw new ToolError("UPSTREAM_FAILURE");
    const now = this.store.now();
    return {
      attempts: parsed.data.attempts.filter((t) => t > now - HOUR),
      blockedUntil: parsed.data.blockedUntil,
    };
  }
  private save(state: z.infer<typeof stateSchema>) {
    this.store.put(
      "YnabRequestBudget",
      this.owner,
      state,
      Math.max(this.store.now() + HOUR, state.blockedUntil),
    );
  }
  admit() {
    this.store.transaction(() => {
      const state = this.read();
      if (state.blockedUntil > this.store.now() || state.attempts.length >= 200)
        throw new ToolError("UPSTREAM_RATE_LIMITED");
      state.attempts.push(this.store.now());
      // Commit before dispatch: ambiguous failures still consume an attempt.
      this.save(state);
    });
  }
  limited() {
    this.store.transaction(() => {
      const state = this.read();
      state.blockedUntil = Math.max(
        state.blockedUntil,
        this.store.now() + HOUR,
      );
      this.save(state);
    });
  }
}
