import { z } from "zod";
import type { Config } from "../config.js";
import { planSchema } from "../fixtures/plans.js";
export const inputSchema = z.strictObject({});
export const outputSchema = z.strictObject({
  data_mode: z.literal("fixtures"),
  plans: z.array(planSchema).max(10),
  truncated: z.literal(false),
});
export function listPlans(config: Config) {
  return outputSchema.parse({
    data_mode: "fixtures",
    plans: config.catalog
      .filter((p) => config.allowedIds.includes(p.id))
      .map((p) => ({ ...p }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    truncated: false,
  });
}
