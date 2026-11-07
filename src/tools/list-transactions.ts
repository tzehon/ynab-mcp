import { success, transactionsOutput } from "./contracts.js";
import type { MockYnabClient } from "../ynab/client.js";
import { ordinal } from "../ynab/contracts.js";
export {
  transactionsInput as inputSchema,
  transactionsOutput as outputSchema,
} from "./contracts.js";
export async function listTransactions(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return client.transactions(value, signal, ({ args, data }) => {
    const eligible = data
      .filter(
        (t) =>
          !t.deleted && t.date >= args.since_date && t.date <= args.until_date,
      )
      .sort((a, b) => ordinal(b.date, a.date) || ordinal(a.id, b.id));
    const transactions = eligible
      .slice(0, args.limit)
      .map(({ deleted: _deleted, amount, subtransactions, ...t }) => ({
        ...t,
        amount_milliunits: amount,
        subtransactions: subtransactions
          .filter((s) => !s.deleted)
          .map(({ deleted: _deleted, amount, ...s }) => ({
            ...s,
            amount_milliunits: amount,
          })),
      }));
    return success(transactionsOutput, {
      ...client.context(args.plan_id),
      truncated: eligible.length > args.limit,
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
