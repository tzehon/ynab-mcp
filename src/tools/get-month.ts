import { success, monthOutput } from "./contracts.js";
import type { MockYnabClient } from "../ynab/client.js";
export {
  monthInput as inputSchema,
  monthOutput as outputSchema,
} from "./contracts.js";
export async function getMonth(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return client.month(value, signal, ({ args, data }) => {
    return success(monthOutput, {
      ...client.context(args.plan_id),
      truncated: false,
      month: {
        month: data.month,
        income_milliunits: data.income,
        assigned_milliunits: data.budgeted,
        activity_milliunits: data.activity,
        activity_is_spending: false,
        category_activity: data.categories
          .filter((c) => !c.deleted)
          .map((c) => ({
            id: c.id,
            category_group_id: c.category_group_id,
            name: c.name,
            hidden: c.hidden,
            internal: c.internal,
            activity_milliunits: c.activity,
          })),
        ready_to_assign_milliunits: data.to_be_budgeted,
      },
    });
  });
}
