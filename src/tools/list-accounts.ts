import { success, accountsOutput } from "./contracts.js";
import type { MockYnabClient } from "../ynab/client.js";
import { ordinal } from "../ynab/contracts.js";
export {
  planInput as inputSchema,
  accountsOutput as outputSchema,
} from "./contracts.js";
export async function listAccounts(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return client.accounts(value, signal, ({ args, data }) => {
    return success(accountsOutput, {
      ...client.context(args.plan_id),
      truncated: false,
      accounts: data
        .filter((a) => !a.deleted)
        .sort((a, b) => ordinal(a.id, b.id))
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          on_budget: a.on_budget,
          closed: a.closed,
          balance_milliunits: a.balance,
          cleared_balance_milliunits: a.cleared_balance,
          uncleared_balance_milliunits: a.uncleared_balance,
        })),
    });
  });
}
