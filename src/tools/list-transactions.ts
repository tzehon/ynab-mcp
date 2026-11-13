import { z } from "zod";
import { success, transactionsOutput } from "./contracts.js";
import type { MockYnabClient } from "../ynab/client.js";
import { ToolError } from "./errors.js";
import { integer, date, id, ordinal } from "../ynab/contracts.js";
export {
  transactionsInput as inputSchema,
  transactionsOutput as outputSchema,
} from "./contracts.js";
export async function listTransactions(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return client.transactions(value, signal, ({ args, data, sourceVersion }) => {
    const eligible = data
      .filter(
        (t) =>
          !t.deleted && t.date >= args.since_date && t.date <= args.until_date,
      )
      .sort((a, b) => ordinal(b.date, a.date) || ordinal(a.id, b.id));
    let start = 0;
    if (args.cursor) {
      try {
        const cursor = z
          .strictObject({
            p: z.string(),
            s: date,
            u: date,
            k: integer.nonnegative(),
            id,
          })
          .parse(
            JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")),
          );
        if (
          cursor.p !== args.plan_id ||
          cursor.s !== args.since_date ||
          cursor.u !== args.until_date ||
          cursor.k !== sourceVersion
        )
          throw new Error();
        start = eligible.findIndex((t) => t.id === cursor.id) + 1;
        if (start === 0) throw new Error();
      } catch {
        throw new ToolError("STALE_CURSOR");
      }
    }
    const page = eligible.slice(start, start + args.limit);
    const more = start + page.length < eligible.length;
    const transactions = page.map(
      ({ deleted: _deleted, amount, subtransactions, ...t }) => ({
        ...t,
        amount_milliunits: amount,
        subtransactions: subtransactions
          .filter((s) => !s.deleted)
          .map(({ deleted: _deleted, amount, ...s }) => ({
            ...s,
            amount_milliunits: amount,
          })),
      }),
    );
    return success(transactionsOutput, {
      ...client.context(args.plan_id),
      truncated: more,
      next_cursor: more
        ? Buffer.from(
            JSON.stringify({
              p: args.plan_id,
              s: args.since_date,
              u: args.until_date,
              k: sourceVersion,
              id: page.at(-1)?.id,
            }),
          ).toString("base64url")
        : null,
      source_version: sourceVersion,
      since_date: args.since_date,
      until_date: args.until_date,
      limit: args.limit,
      returned_count: transactions.length,
      available_count: eligible.length,
      pending_excluded: true,
      transactions,
    });
  });
}
