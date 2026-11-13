import type { z } from "zod";
import type { Config } from "../config.js";
import {
  monthInput,
  parseInput,
  fixturePlanId,
  planInput,
  transactionsInput,
} from "../tools/contracts.js";
import { ToolError } from "../tools/errors.js";
import {
  accountsResponse,
  categoriesResponse,
  MAX_BODY,
  uuid,
  monthResponse,
  transactionsResponse,
} from "./contracts.js";
import { type AdmissionBudget, CallLimits } from "./limits.js";
import { descriptor, type MockTransport, type Operation } from "./transport.js";

function cap(value: unknown, max: number) {
  if (Array.isArray(value) && value.length > max)
    throw new ToolError("UPSTREAM_RESPONSE_TOO_LARGE");
}
function rawCaps(value: unknown) {
  const data = (value as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return;
  cap(data.accounts, 200);
  cap((data.month as { categories?: unknown } | null)?.categories, 1000);
  cap(data.category_groups, 100);
  if (Array.isArray(data.category_groups)) {
    let count = 0;
    for (const group of data.category_groups)
      if (Array.isArray(group?.categories)) count += group.categories.length;
    if (count > 1000) throw new ToolError("UPSTREAM_RESPONSE_TOO_LARGE");
  }
  cap(data.transactions, 1000);
  if (Array.isArray(data.transactions)) {
    let count = 0;
    for (const t of data.transactions) {
      cap(t?.subtransactions, 100);
      if (Array.isArray(t?.subtransactions)) count += t.subtransactions.length;
    }
    if (count > 2000) throw new ToolError("UPSTREAM_RESPONSE_TOO_LARGE");
  }
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length)
    throw new ToolError("UPSTREAM_INVALID_RESPONSE");
}
async function collect(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  check: () => void,
) {
  const iterator = body[Symbol.asyncIterator]();
  const cancel = () => {
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {}
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0,
    complete = false;
  try {
    while (true) {
      check();
      const item = await iterator.next();
      check();
      if (item.done) {
        complete = true;
        break;
      }
      if (!(item.value instanceof Uint8Array))
        throw new ToolError("UPSTREAM_INVALID_RESPONSE");
      size += item.value.byteLength;
      if (size > MAX_BODY) throw new ToolError("UPSTREAM_RESPONSE_TOO_LARGE");
      chunks.push(item.value.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
  }
}
export type ClientSnapshot = {
  lookup: (id: string) => {
    mapped_id: string;
    currency_code: string;
    as_of: string;
  };
  check: () => void;
};
export class MockYnabClient {
  private limits: CallLimits;
  constructor(
    readonly config: Config,
    private transport: MockTransport,
    budget?: AdmissionBudget,
    private live?: ClientSnapshot,
  ) {
    if (typeof transport !== "function") throw new ToolError("INTERNAL_ERROR");
    this.limits = new CallLimits(budget);
  }
  context(plan: string) {
    if (this.live) {
      this.live.check();
      const entry = this.live.lookup(plan);
      return {
        data_mode: "live" as const,
        source: "ynab" as const,
        plan_id: plan,
        currency_code: entry.currency_code,
        as_of: new Date().toISOString(),
      };
    }
    if (
      !this.config.allowedIds.includes(plan) ||
      !Object.hasOwn(this.config.fixtureMap, plan)
    )
      throw new ToolError("PLAN_NOT_ALLOWED");
    const entry = this.config.fixtureMap[plan];
    if (!entry) throw new ToolError("PLAN_NOT_ALLOWED");
    return {
      data_mode: "fixtures" as const,
      source: "mock-ynab" as const,
      plan_id: plan,
      currency_code: entry.currency_code,
      as_of: entry.as_of,
    };
  }
  private async request<S extends z.ZodType, R>(
    operation: Operation,
    args: {
      plan_id: string;
      month?: string;
      since_date?: string;
      until_date?: string;
    },
    schema: S,
    project: (data: z.infer<S>) => R,
    signal?: AbortSignal,
  ): Promise<R> {
    this.context(args.plan_id);
    const entry =
      this.live?.lookup(args.plan_id) ?? this.config.fixtureMap[args.plan_id];
    if (!entry) throw new ToolError("PLAN_NOT_ALLOWED");
    return this.limits.run(signal, async (abort, check) => {
      let receiving = true;
      try {
        const response = await this.transport(
          descriptor(operation, entry.mapped_id, args),
          abort,
        );
        check();
        const status = response.status;
        if (status !== 200) {
          const code =
            status === 401
              ? "UPSTREAM_UNAUTHORIZED"
              : status === 403
                ? "UPSTREAM_FORBIDDEN"
                : status === 404
                  ? "NOT_FOUND"
                  : status === 429
                    ? "UPSTREAM_RATE_LIMITED"
                    : Number.isInteger(status) && status >= 500 && status <= 599
                      ? "UPSTREAM_UNAVAILABLE"
                      : "UPSTREAM_FAILURE";
          throw new ToolError(code);
        }
        const raw = await collect(response.body, abort, check);
        check();
        receiving = false;
        rawCaps(raw);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new ToolError("UPSTREAM_INVALID_RESPONSE");
        check();
        this.live?.check();
        const result = project(parsed.data);
        this.live?.check();
        check();
        return result;
      } catch (error) {
        check();
        if (error instanceof ToolError) throw error;
        throw new ToolError(receiving ? "UPSTREAM_FAILURE" : "INTERNAL_ERROR");
      }
    });
  }
  accounts<R>(
    value: unknown,
    signal: AbortSignal | undefined,
    project: (value: {
      args: z.infer<typeof planInput>;
      data: z.infer<typeof accountsResponse>["data"]["accounts"];
    }) => R,
  ) {
    const args = parseInput(
      planInput.safeExtend({ plan_id: this.live ? uuid : fixturePlanId }),
      value,
    );
    return this.request(
      "accounts",
      args,
      accountsResponse,
      ({ data }) => {
        unique(data.accounts.map((a) => a.id.toLowerCase()));
        return project({ args, data: data.accounts });
      },
      signal,
    );
  }
  month<R>(
    value: unknown,
    signal: AbortSignal | undefined,
    project: (value: {
      args: z.infer<typeof monthInput>;
      data: z.infer<typeof monthResponse>["data"]["month"];
    }) => R,
  ) {
    const args = parseInput(
      monthInput.safeExtend({ plan_id: this.live ? uuid : fixturePlanId }),
      value,
    );
    return this.request(
      "month",
      args,
      monthResponse,
      ({ data }) => {
        if (data.month.month !== args.month)
          throw new ToolError("UPSTREAM_INVALID_RESPONSE");
        if (data.month.deleted) throw new ToolError("NOT_FOUND");
        return project({ args, data: data.month });
      },
      signal,
    );
  }
  categories<R>(
    value: unknown,
    signal: AbortSignal | undefined,
    project: (value: {
      args: z.infer<typeof planInput>;
      data: z.infer<typeof categoriesResponse>["data"]["category_groups"];
    }) => R,
  ) {
    const args = parseInput(
      planInput.safeExtend({ plan_id: this.live ? uuid : fixturePlanId }),
      value,
    );
    return this.request(
      "categories",
      args,
      categoriesResponse,
      ({ data }) => {
        unique(data.category_groups.map((g) => g.id.toLowerCase()));
        unique(
          data.category_groups.flatMap((g) =>
            g.categories.map((c) => c.id.toLowerCase()),
          ),
        );
        if (
          data.category_groups.some((g) =>
            g.categories.some((c) => c.category_group_id !== g.id),
          )
        )
          throw new ToolError("UPSTREAM_INVALID_RESPONSE");
        return project({ args, data: data.category_groups });
      },
      signal,
    );
  }
  transactions<R>(
    value: unknown,
    signal: AbortSignal | undefined,
    project: (value: {
      args: z.infer<typeof transactionsInput>;
      data: z.infer<typeof transactionsResponse>["data"]["transactions"];
    }) => R,
  ) {
    const args = parseInput(
      transactionsInput.safeExtend({
        plan_id: this.live ? uuid : fixturePlanId,
      }),
      value,
    );
    return this.request(
      "transactions",
      args,
      transactionsResponse,
      ({ data }) => {
        unique(
          data.transactions.flatMap((t) => [
            t.id,
            ...t.subtransactions.map((s) => s.id),
          ]),
        );
        if (
          data.transactions.some((t) =>
            t.subtransactions.some((s) => s.transaction_id !== t.id),
          )
        )
          throw new ToolError("UPSTREAM_INVALID_RESPONSE");
        return project({ args, data: data.transactions });
      },
      signal,
    );
  }
  close() {
    this.limits.close();
  }
}
