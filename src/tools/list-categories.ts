import { success, categoriesOutput } from "./contracts.js";
import type { MockYnabClient } from "../ynab/client.js";
import { ordinal } from "../ynab/contracts.js";
export {
  planInput as inputSchema,
  categoriesOutput as outputSchema,
} from "./contracts.js";
export async function listCategories(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return client.categories(value, signal, ({ args, data }) => {
    const fields = (c: {
      id: string;
      name: string;
      hidden: boolean;
      internal: boolean;
    }) => ({ id: c.id, name: c.name, hidden: c.hidden, internal: c.internal });
    return success(categoriesOutput, {
      ...client.context(args.plan_id),
      truncated: false,
      category_groups: data
        .filter((g) => !g.deleted)
        .sort((a, b) => ordinal(a.id, b.id))
        .map((g) => ({
          ...fields(g),
          categories: g.categories
            .filter((c) => !c.deleted)
            .sort((a, b) => ordinal(a.id, b.id))
            .map(fields),
        })),
    });
  });
}
