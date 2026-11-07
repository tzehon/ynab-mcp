import { z } from "zod";
import { ConfigError } from "../errors.js";

export const planSchema = z.strictObject({
  id: z.string().regex(/^fixture-plan-[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
});
export type Plan = Readonly<z.infer<typeof planSchema>>;
export const fixturePlans: readonly Plan[] = Object.freeze([
  Object.freeze({
    id: "fixture-plan-sgd",
    name: "Invented Singapore plan",
    currency_code: "SGD",
  }),
  Object.freeze({
    id: "fixture-plan-usd",
    name: "Invented US plan",
    currency_code: "USD",
  }),
]);
export function validateCatalog(value: unknown): readonly Plan[] {
  const parsed = z.array(planSchema).max(10).safeParse(value);
  if (
    !parsed.success ||
    new Set(parsed.data.map((p) => p.id)).size !== parsed.data.length
  )
    throw new ConfigError("CATALOG");
  return Object.freeze(parsed.data.map((p) => Object.freeze(p)));
}
