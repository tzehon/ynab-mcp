import { z } from "zod";
import {
  accountType,
  cleared,
  date,
  id,
  integer,
  MAX_RESULT,
  name,
  uuid,
} from "../ynab/contracts.js";
import { ToolError } from "./errors.js";
export const fixturePlanId = z.string().regex(/^fixture-plan-[a-z0-9-]{1,40}$/);
export const planId = z.union([fixturePlanId, uuid]);
export const planInput = z.strictObject({ plan_id: planId });
export const monthInput = z.strictObject({
  plan_id: planId,
  month: date.refine((v) => v.endsWith("-01")),
});
export const transactionsInput = z
  .strictObject({
    plan_id: planId,
    since_date: date,
    until_date: date,
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((v) => {
    const days =
      (Date.parse(`${v.until_date}T00:00:00Z`) -
        Date.parse(`${v.since_date}T00:00:00Z`)) /
        86400000 +
      1;
    return days >= 1 && days <= 90;
  });
export const common = {
  data_mode: z.enum(["fixtures", "live"]),
  source: z.enum(["mock-ynab", "ynab"]),
  plan_id: planId,
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  as_of: z.iso.datetime(),
  truncated: z.boolean(),
};
export const accountOutput = z.strictObject({
  id: uuid,
  name,
  type: accountType,
  on_budget: z.boolean(),
  closed: z.boolean(),
  balance_milliunits: integer,
  cleared_balance_milliunits: integer,
  uncleared_balance_milliunits: integer,
});
export const accountsOutput = z.strictObject({
  ...common,
  truncated: z.literal(false),
  accounts: z.array(accountOutput).max(200),
});
export const monthOutput = z.strictObject({
  ...common,
  truncated: z.literal(false),
  month: z.strictObject({
    month: date,
    income_milliunits: integer,
    assigned_milliunits: integer,
    activity_milliunits: integer,
    ready_to_assign_milliunits: integer,
  }),
});
const cat = { id: uuid, name, hidden: z.boolean(), internal: z.boolean() };
export const categoriesOutput = z.strictObject({
  ...common,
  truncated: z.literal(false),
  category_groups: z
    .array(z.strictObject({ ...cat, categories: z.array(z.strictObject(cat)) }))
    .max(100),
});
const nullableFields = {
  payee_id: uuid.nullable(),
  payee_name: name.nullable(),
  category_id: uuid.nullable(),
  category_name: name.nullable(),
  memo: z.string().max(500).nullable(),
  transfer_account_id: uuid.nullable(),
  transfer_transaction_id: id.nullable(),
};
export const childOutput = z.strictObject({
  id,
  transaction_id: id,
  amount_milliunits: integer,
  ...nullableFields,
});
export const transactionOutput = z.strictObject({
  id,
  date,
  amount_milliunits: integer,
  account_id: uuid,
  account_name: name,
  approved: z.boolean(),
  cleared,
  ...nullableFields,
  subtransactions: z.array(childOutput).max(100),
});
export const transactionsOutput = z.strictObject({
  ...common,
  since_date: date,
  until_date: date,
  limit: z.number().int().min(1).max(100),
  returned_count: z.number().int().min(0).max(100),
  available_count: z.number().int().min(0).max(1000),
  pending_excluded: z.literal(true),
  transactions: z.array(transactionOutput).max(100),
});
export function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const p = schema.safeParse(value);
  if (!p.success) throw new ToolError("INVALID_ARGUMENTS");
  return p.data;
}
export function success<T extends z.ZodType>(schema: T, value: unknown) {
  const data = schema.parse(value);
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_RESULT)
    throw new ToolError("RESULT_TOO_LARGE");
  return {
    structuredContent: data as Record<string, unknown>,
    content: [{ type: "text" as const, text }],
  };
}
