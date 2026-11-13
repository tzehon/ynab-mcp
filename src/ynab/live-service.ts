import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireCurrentAuthorization } from "../auth/authorization-context.js";
import type { Config } from "../config.js";
import type { HostedLifecycle } from "../oauth/hosted-lifecycle.js";
import type { Store } from "../oauth/store.js";
import { ToolError } from "../tools/errors.js";
import { MockYnabClient } from "./client.js";
import { uuid } from "./contracts.js";
import {
  createCatalogTransport,
  createHttpTransport,
} from "./http-transport.js";
import { CallLimits } from "./limits.js";

export const livePlanSchema = z.strictObject({
  id: uuid,
  name: z.string().min(1).max(200),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
});
export const livePlansOutput = z.strictObject({
  data_mode: z.literal("live"),
  plans: z.array(livePlanSchema).max(10),
  truncated: z.literal(false),
});
type Plan = z.infer<typeof livePlanSchema>;
const selectionSchema = z.strictObject({
  version: z.string().uuid(),
  generation: z.string().min(1),
  plans: z.array(livePlanSchema).max(10),
});
const catalogSchema = z.object({
  data: z.object({
    plans: z
      .array(
        z.object({
          id: uuid,
          name: z.string().min(1).max(200),
          currency_format: z.object({
            iso_code: z.string().regex(/^[A-Z]{3}$/),
          }),
        }),
      )
      .max(100),
  }),
});
function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ToolError("UPSTREAM_INVALID_RESPONSE");
  return r.data;
}
function unique(plans: readonly Plan[]) {
  if (new Set(plans.map((p) => p.id.toLowerCase())).size !== plans.length)
    throw new ToolError("UPSTREAM_INVALID_RESPONSE");
}
export interface LiveTools {
  plans(): z.infer<typeof livePlansOutput>;
  run<T>(work: (client: MockYnabClient) => Promise<T>): Promise<T>;
  close(): void;
}
export class LiveService implements LiveTools {
  private limits = new CallLimits();
  private clients = new Set<MockYnabClient>();
  private closed = false;
  constructor(
    private config: Config,
    private store: Store,
    private lifecycle: HostedLifecycle,
    private fetcher: typeof fetch,
  ) {}
  private current(generation?: string) {
    if (this.closed) throw new ToolError("UPSTREAM_UNAUTHORIZED");
    const c = this.lifecycle.current();
    if (!c || (generation !== undefined && c.generation !== generation))
      throw new ToolError("UPSTREAM_UNAUTHORIZED");
    return c;
  }
  private selection() {
    const c = this.current();
    const raw = this.store.get("PlanSelection", this.lifecycle.owner);
    if (!raw)
      return { generation: c.generation, version: "", plans: [] as Plan[] };
    const selection = valid(selectionSchema, raw);
    if (selection.generation !== c.generation)
      throw new ToolError("UPSTREAM_UNAUTHORIZED");
    unique(selection.plans);
    return selection;
  }
  private async token(generation: string, signal: AbortSignal) {
    this.current(generation);
    if (signal.aborted) throw new ToolError("UPSTREAM_TIMEOUT");
    // A shared refresh already sent must settle even if one reader cancels.
    await this.lifecycle.refresh();
    if (signal.aborted) throw new ToolError("UPSTREAM_TIMEOUT");
    const c = this.current(generation);
    if (c.status !== "active" || c.tokens.expires <= this.store.now())
      throw new ToolError("UPSTREAM_UNAUTHORIZED");
    return c.tokens.access;
  }
  selectedIds() {
    return this.selection().plans.map((p) => p.id);
  }
  plans() {
    requireCurrentAuthorization();
    const selection = this.selection();
    return livePlansOutput.parse({
      data_mode: "live",
      plans: selection.plans,
      truncated: false,
    });
  }
  async run<T>(work: (client: MockYnabClient) => Promise<T>): Promise<T> {
    requireCurrentAuthorization();
    const selection = this.selection();
    const check = () => {
      requireCurrentAuthorization();
      this.current(selection.generation);
      if (this.selection().version !== selection.version)
        throw new ToolError("PLAN_NOT_ALLOWED");
    };
    const client = new MockYnabClient(
      this.config,
      createHttpTransport({
        allowedMappedIds: selection.plans.map((p) => p.id),
        accessToken: async (signal) => {
          check();
          const token = await this.token(selection.generation, signal);
          check();
          return token;
        },
        fetcher: this.fetcher,
      }),
      undefined,
      {
        check,
        lookup: (id) => {
          check();
          const p = selection.plans.find((p) => p.id === id);
          if (!p) throw new ToolError("PLAN_NOT_ALLOWED");
          return {
            mapped_id: p.id,
            currency_code: p.currency_code,
            as_of: new Date().toISOString(),
          };
        },
      },
    );
    this.clients.add(client);
    try {
      const result = await work(client);
      check();
      return result;
    } finally {
      client.close();
      this.clients.delete(client);
    }
  }
  async discover(signal?: AbortSignal) {
    const generation = this.current().generation;
    return this.limits.run(signal, async (abort, check) => {
      const response = await createCatalogTransport({
        accessToken: (signal) => this.token(generation, signal),
        fetcher: this.fetcher,
      })(abort);
      check();
      if (response.status !== 200)
        throw new ToolError(
          response.status === 429
            ? "UPSTREAM_RATE_LIMITED"
            : "UPSTREAM_FAILURE",
        );
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      try {
        for await (const chunk of response.body) {
          check();
          text += decoder.decode(chunk, { stream: true });
        }
        text += decoder.decode();
      } catch {
        throw new ToolError("UPSTREAM_INVALID_RESPONSE");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ToolError("UPSTREAM_INVALID_RESPONSE");
      }
      const plans = valid(catalogSchema, raw).data.plans.map((p) => ({
        id: p.id,
        name: p.name,
        currency_code: p.currency_format.iso_code,
      }));
      unique(plans);
      check();
      this.current(generation);
      return { generation, plans };
    });
  }
  select(generation: string, candidates: unknown, ids: string[]) {
    this.current(generation);
    const plans = valid(z.array(livePlanSchema).max(100), candidates);
    unique(plans);
    if (
      ids.length > 10 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !plans.some((p) => p.id === id))
    )
      throw new ToolError("PLAN_NOT_ALLOWED");
    const selected = plans.filter((p) => ids.includes(p.id));
    this.store.put(
      "PlanSelection",
      this.lifecycle.owner,
      {
        generation,
        version: randomUUID(),
        plans: selected,
      },
      Number.MAX_SAFE_INTEGER,
    );
  }
  close() {
    this.closed = true;
    this.limits.close();
    for (const client of this.clients) client.close();
  }
}
