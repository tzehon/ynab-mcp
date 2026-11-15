import { getSpendingAnalysis } from "../tools/get-spending-analysis.js";
import {
  outputSchema as analysisSchema,
  requestedMonths,
} from "../tools/spending-analysis.js";
import { success } from "../tools/contracts.js";
import { AnalysisCache } from "./analysis-cache.js";
import { RequestBudget } from "./request-budget.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authorizationContext,
  requireCurrentAuthorization,
} from "../auth/authorization-context.js";
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
  analysis(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof success<typeof analysisSchema>>>;
  close(): void;
}
export class LiveService implements LiveTools {
  private limits = new CallLimits();
  private clients = new Set<MockYnabClient>();
  private closed = false;
  private cache = new AnalysisCache<z.infer<typeof analysisSchema>>();
  private cacheScope = "";
  private unsubscribe: () => void;
  private budget: RequestBudget;
  constructor(
    private config: Config,
    private store: Store,
    private lifecycle: HostedLifecycle,
    private fetcher: typeof fetch,
  ) {
    this.budget = new RequestBudget(store, lifecycle.owner);
    this.unsubscribe = lifecycle.onDisconnect(() => this.cache.clear());
  }
  private budgetFetch: typeof fetch = async (url, init) => {
    if (init?.signal?.aborted) throw new ToolError("UPSTREAM_TIMEOUT");
    this.budget.admit();
    const response = await this.fetcher(url, init);
    if (response.status === 429) this.budget.limited();
    return response;
  };
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
        fetcher: this.budgetFetch,
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
  async analysis(value: unknown, signal?: AbortSignal) {
    requireCurrentAuthorization();
    const callerAuthorization = authorizationContext.getStore();
    if (!callerAuthorization) throw new ToolError("UPSTREAM_UNAUTHORIZED");
    const { args } = requestedMonths(value);
    const selection = this.selection();
    const scope = JSON.stringify([selection.generation, selection.version]);
    if (scope !== this.cacheScope) {
      this.cache.clear();
      this.cacheScope = scope;
    }
    const sharedCheck = () => {
      this.current(selection.generation);
      if (
        this.selection().version !== selection.version ||
        !selection.plans.some((p) => p.id === args.plan_id)
      )
        throw new ToolError("PLAN_NOT_ALLOWED");
    };
    const check = () => {
      authorizationContext.run(
        callerAuthorization,
        requireCurrentAuthorization,
      );
      sharedCheck();
    };
    check();
    const { refresh, ...query } = args;
    const work = (abort: AbortSignal) =>
      authorizationContext.run(sharedCheck, () =>
        this.run(async (client) => {
          const result = await getSpendingAnalysis(client, query, abort);
          return analysisSchema.parse(result.structuredContent);
        }),
      );
    // Provisional periods always read upstream, including concurrent calls.
    if (args.include_open_month) {
      const started = Date.now();
      const result = await work(signal ?? new AbortController().signal);
      check();
      return success(analysisSchema, {
        ...result,
        freshness: {
          source: "fresh",
          fetched_at: new Date(started).toISOString(),
          expires_at: new Date(started).toISOString(),
          max_age_seconds: 0,
        },
      });
    }
    const result = await this.cache.get(
      JSON.stringify([scope, query]),
      refresh,
      signal,
      check,
      work,
    );
    check();
    return success(analysisSchema, {
      ...result.value,
      freshness: {
        source: result.reused ? "reused" : "fresh",
        fetched_at: new Date(result.started).toISOString(),
        expires_at: new Date(result.expires).toISOString(),
        max_age_seconds: 120,
      },
    });
  }
  async discover(signal?: AbortSignal) {
    const generation = this.current().generation;
    return this.limits.run(signal, async (abort, check) => {
      const response = await createCatalogTransport({
        accessToken: (signal) => this.token(generation, signal),
        fetcher: this.budgetFetch,
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
    this.cache.clear();
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
    this.unsubscribe();
    this.cache.clear();
    this.limits.close();
    for (const client of this.clients) client.close();
  }
}
