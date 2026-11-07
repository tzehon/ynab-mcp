import { z } from "zod";
export const MAX_BODY = 1048576;
export const MAX_RESULT = 65536;
export const integer = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const id = z.string().min(1).max(100);
export const name = z.string().min(1).max(200);
export function validDate(value: string) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}
export const date = z.string().refine(validDate);
export const accountType = z.enum([
  "checking",
  "savings",
  "cash",
  "creditCard",
  "lineOfCredit",
  "otherAsset",
  "otherLiability",
  "mortgage",
  "autoLoan",
  "studentLoan",
  "personalLoan",
  "medicalDebt",
  "otherDebt",
]);
export const cleared = z.enum(["cleared", "uncleared", "reconciled"]);
const nullable = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? null);
export const account = z.object({
  id: uuid,
  name,
  type: accountType,
  on_budget: z.boolean(),
  closed: z.boolean(),
  balance: integer,
  cleared_balance: integer,
  uncleared_balance: integer,
  transfer_payee_id: uuid.nullable(),
  deleted: z.boolean(),
});
export const category = z.object({
  id: uuid,
  name,
  category_group_id: uuid,
  hidden: z.boolean(),
  internal: z.boolean(),
  deleted: z.boolean(),
});
export const group = z.object({
  id: uuid,
  name,
  hidden: z.boolean(),
  internal: z.boolean(),
  deleted: z.boolean(),
  categories: z.array(category),
});
export const month = z.object({
  month: date,
  income: integer,
  budgeted: integer,
  activity: integer,
  to_be_budgeted: integer,
  deleted: z.boolean(),
  categories: z.array(z.unknown()),
});
const nullableFields = {
  payee_id: nullable(uuid),
  payee_name: nullable(name),
  category_id: nullable(uuid),
  category_name: nullable(name),
  memo: nullable(z.string().max(500)),
  transfer_account_id: nullable(uuid),
  transfer_transaction_id: nullable(id),
};
export const child = z.object({
  id,
  transaction_id: id,
  amount: integer,
  deleted: z.boolean(),
  ...nullableFields,
});
export const transaction = z.object({
  id,
  date,
  amount: integer,
  account_id: uuid,
  account_name: name,
  approved: z.boolean(),
  cleared,
  deleted: z.boolean(),
  subtransactions: z.array(child),
  ...nullableFields,
});
const knowledge = integer.nonnegative();
export const accountsResponse = z.object({
  data: z.object({ accounts: z.array(account), server_knowledge: knowledge }),
});
export const categoriesResponse = z.object({
  data: z.object({
    category_groups: z.array(group),
    server_knowledge: knowledge,
  }),
});
export const monthResponse = z.object({ data: z.object({ month }) });
export const transactionsResponse = z.object({
  data: z.object({
    transactions: z.array(transaction),
    server_knowledge: knowledge,
  }),
});
export const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
