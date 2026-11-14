import { createHash } from "node:crypto";
import { z } from "zod";
import { date, integer, name, ordinal, uuid } from "../ynab/contracts.js";
import { common, monthInput, parseInput } from "./contracts.js";
import { ToolError } from "./errors.js";
import { outputSchema as reportSchema } from "./get-spending-report.js";

const month = monthInput.shape.month;
export const inputSchema = z.strictObject({
  plan_id: monthInput.shape.plan_id,
  first_month: month,
  last_month: month,
  comparison_month: month.optional(),
  include_open_month: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;
type Report = z.infer<typeof reportSchema>;
const amounts = z.strictObject({
  gross_outflow_milliunits: integer.nonnegative(),
  category_credit_milliunits: integer.nonnegative(),
  net_spending_milliunits: integer,
  categorized_transfer_net_milliunits: integer,
});
type Amounts = z.infer<typeof amounts>;
const keys = Object.keys(amounts.shape) as (keyof Amounts)[];
const category = z.strictObject({
  id: uuid,
  name,
  category_group_name: name,
  ...amounts.shape,
});
const comparisonSchema = z.strictObject({
  previous_month: month,
  month,
  previous_net_milliunits: integer,
  net_milliunits: integer,
  change_milliunits: integer,
  direction: z.enum(["increase", "decrease", "unchanged"]),
  percent_change_basis_points: integer.nullable(),
  category_changes: z
    .array(z.strictObject({ id: uuid, name, change_milliunits: integer }))
    .max(100),
});
export const outputSchema = z.strictObject({
  ...common,
  truncated: z.literal(false),
  complete: z.literal(true),
  method: z.literal("validated-spending-analysis-v1"),
  report_method: z.literal("reconciled-category-spending-v1"),
  first_month: month,
  last_month: month,
  since_date: date,
  until_date: date,
  all_periods_closed: z.boolean(),
  source_transaction_count: integer.nonnegative(),
  zero_activity_categories_omitted: integer.nonnegative(),
  totals: amounts,
  months: z
    .array(
      z.strictObject({
        month,
        as_of: z.iso.datetime(),
        period_closed: z.boolean(),
        ...amounts.shape,
      }),
    )
    .min(1)
    .max(6),
  categories: z.array(category).max(100),
  comparison: comparisonSchema.nullable(),
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  canonical_answer: z.string().max(20000),
  charts: z
    .array(
      z.strictObject({
        kind: z.enum(["monthly", "category", "comparison"]),
        mime_type: z.literal("image/svg+xml"),
        svg: z.string().max(65536),
      }),
    )
    .min(2)
    .max(3),
});
function fail(): never {
  throw new ToolError("SPENDING_ANALYSIS_INVALID");
}
export function add(a: number, b: number) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) fail();
  return n;
}
const empty = (): Amounts => ({
  gross_outflow_milliunits: 0,
  category_credit_milliunits: 0,
  net_spending_milliunits: 0,
  categorized_transfer_net_milliunits: 0,
});
function sum(target: Amounts, value: Amounts) {
  for (const k of keys) target[k] = add(target[k], value[k]);
}
function equal(a: Amounts, b: Amounts) {
  return keys.every((k) => a[k] === b[k]);
}
function index(value: string) {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}
function fromIndex(i: number) {
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}-01`;
}
function endOfMonth(value: string) {
  return new Date(
    Date.parse(`${fromIndex(index(value) + 1)}T00:00:00Z`) - 86400000,
  )
    .toISOString()
    .slice(0, 10);
}
export function requestedMonths(value: unknown) {
  const args = parseInput(inputSchema, value);
  const length = index(args.last_month) - index(args.first_month) + 1;
  if (
    length < 1 ||
    length > 6 ||
    (args.comparison_month &&
      (args.comparison_month <= args.first_month ||
        args.comparison_month > args.last_month))
  ) {
    throw new ToolError("INVALID_ARGUMENTS");
  }
  return {
    args,
    months: Array.from({ length }, (_, i) =>
      fromIndex(index(args.first_month) + i),
    ),
  };
}
// Exact display conversion; no binary floating-point rounding of financial amounts.
export function money(value: number) {
  if (!Number.isSafeInteger(value)) fail();
  const n = BigInt(value),
    absolute = n < 0n ? -n : n;
  const fraction = String(absolute % 1000n).padStart(3, "0");
  return `${n < 0n ? "-" : ""}${String(absolute / 1000n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.endsWith("0") ? fraction.slice(0, 2) : fraction}`;
}
function percent(change: number, baseline: number) {
  if (baseline <= 0) return null;
  const raw = BigInt(change) * 10000n,
    abs = raw < 0n ? -raw : raw,
    b = BigInt(baseline);
  const rounded = ((abs + b / 2n) / b) * (raw < 0n ? -1n : 1n);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) fail();
  return result;
}
function xml(value: string) {
  for (const char of value) {
    const n = char.codePointAt(0) ?? 0;
    if (
      (n < 32 && n !== 9 && n !== 10 && n !== 13) ||
      (n >= 0xd800 && n <= 0xdfff) ||
      n === 0xfffe ||
      n === 0xffff
    )
      fail();
  }
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] ?? c,
  );
}
type Row = { id: string; label: string; value: number };
// Output is an inert, self-contained SVG. All financial labels use exact milliunits.
// Scaling affects only bar geometry; zero remains visible and negative bars go left.
export function chartSvg(
  title: string,
  currency: string,
  rows: Row[],
  digest: string,
  caption = "",
  emptyMessage = "No category activity; reconciled zero.",
) {
  if (rows.length > 100) throw new ToolError("RESULT_TOO_LARGE");
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  let y = 72;
  const captionText = (caption.match(/.{1,85}/gu) ?? [])
    .map((line) => {
      const text = `<text x="24" y="${y}">${xml(line)}</text>`;
      y += 20;
      return text;
    })
    .join("");
  y += 20;
  const body = rows
    .map((r) => {
      const lines = Array.from(r.label)
        .join("")
        .match(/.{1,70}/gu) ?? [r.label];
      const label = lines
        .map((line) => {
          const t = `<text x="24" y="${y}">${xml(line)}</text>`;
          y += 20;
          return t;
        })
        .join("");
      const value = `<text x="24" y="${y}" font-weight="bold">${xml(currency)} ${money(r.value)}</text>`;
      y += 10;
      const width = (Math.abs(r.value) / max) * 344;
      const bar = `<line x1="384" x2="384" y1="${y}" y2="${y + 16}" stroke="#687080"/><rect x="${r.value < 0 ? 384 - width : 384}" y="${y}" width="${width}" height="16" fill="${r.value < 0 ? "#8a4d9e" : "#176b91"}"/>`;
      y += 42;
      return `<g data-row-id="${xml(r.id)}" data-milliunits="${r.value}"><title>${xml(r.label)}: ${xml(currency)} ${money(r.value)}</title>${label}${value}${bar}</g>`;
    })
    .join("");
  if (rows.length === 0) y += 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 ${y + 28}" role="img" aria-label="${xml(title)}" data-evidence-digest="${digest}"><rect width="768" height="${y + 28}" fill="#fff"/><g fill="#17212b" font-family="sans-serif" font-size="16"><text x="24" y="28" font-size="20">${xml(title)}</text><text x="24" y="50">${xml(currency)} · net of category credits · zero at centre</text>${captionText}${body}${rows.length ? "" : `<text x="24" y="${y}">${xml(emptyMessage)}</text>`}</g></svg>`;
  if (Buffer.byteLength(svg) > 65536) throw new ToolError("RESULT_TOO_LARGE");
  return svg;
}

export function compileAnalysis(input: unknown, values: unknown[]) {
  const { args, months } = requestedMonths(input);
  if (values.length !== months.length) fail();
  const reports: Report[] = values.map((v) => {
    const p = reportSchema.safeParse(v);
    if (!p.success) fail();
    return p.data;
  });
  const first = reports[0];
  if (!first) fail();
  const totals = empty();
  const categories = new Map<string, z.infer<typeof category>>();
  const metadata = new Map<string, string>();
  const monthlyCategories: Map<string, number>[] = [];
  let count = 0;
  for (const [i, r] of reports.entries()) {
    if (
      r.plan_id !== args.plan_id ||
      r.month !== months[i] ||
      r.since_date !== r.month ||
      r.until_date !== endOfMonth(r.month) ||
      r.currency_code !== first.currency_code ||
      r.data_mode !== first.data_mode ||
      r.source !== first.source ||
      (r.data_mode === "live") !== (r.source === "ynab") ||
      r.method !== first.method ||
      r.period_closed !== r.until_date < r.as_of.slice(0, 10) ||
      (!args.include_open_month && !r.period_closed)
    )
      fail();
    const monthSum = empty(),
      ids = new Set<string>(),
      map = new Map<string, number>();
    for (const c of r.categories) {
      const id = c.id.toLowerCase();
      const meta = JSON.stringify([
        c.name,
        c.category_group_id.toLowerCase(),
        c.category_group_name,
        c.hidden,
      ]);
      if (
        ids.has(id) ||
        (metadata.has(id) && metadata.get(id) !== meta) ||
        add(c.gross_outflow_milliunits, -c.category_credit_milliunits) !==
          c.net_spending_milliunits ||
        c.net_spending_milliunits !== -c.activity_milliunits
      )
        fail();
      ids.add(id);
      metadata.set(id, meta);
      map.set(id, c.net_spending_milliunits);
      const aggregate = categories.get(id) ?? {
        id,
        name: c.name,
        category_group_name: c.category_group_name,
        ...empty(),
      };
      sum(aggregate, c);
      categories.set(id, aggregate);
      sum(monthSum, c);
    }
    const q = r.reconciliation;
    if (
      !equal(monthSum, r.totals) ||
      add(
        r.totals.gross_outflow_milliunits,
        -r.totals.category_credit_milliunits,
      ) !== r.totals.net_spending_milliunits ||
      -r.totals.net_spending_milliunits !==
        q.spending_category_activity_milliunits ||
      add(
        q.spending_category_activity_milliunits,
        q.payment_category_activity_milliunits,
      ) !== q.budget_activity_milliunits
    )
      fail();
    sum(totals, r.totals);
    count = add(count, r.coverage.source_transaction_count);
    monthlyCategories.push(map);
  }
  const allCategories = [...categories.values()].sort((a, b) =>
    ordinal(a.id, b.id),
  );
  const activeCategories = allCategories.filter((c) =>
    keys.some((k) => c[k] !== 0),
  );
  if (activeCategories.length > 100) throw new ToolError("RESULT_TOO_LARGE");
  let comparison: z.infer<typeof comparisonSchema> | null = null;
  if (months.length > 1) {
    const i = months.indexOf(args.comparison_month ?? args.last_month);
    const previous = reports[i - 1],
      current = reports[i],
      before = monthlyCategories[i - 1],
      after = monthlyCategories[i];
    if (!previous || !current || !before || !after) fail();
    const change = add(
      current.totals.net_spending_milliunits,
      -previous.totals.net_spending_milliunits,
    );
    const changes = allCategories
      .map((c) => ({
        id: c.id,
        name: c.name,
        change_milliunits: add(after.get(c.id) ?? 0, -(before.get(c.id) ?? 0)),
      }))
      .filter((c) => c.change_milliunits !== 0);
    if (changes.reduce((n, c) => add(n, c.change_milliunits), 0) !== change)
      fail();
    comparison = {
      previous_month: previous.month,
      month: current.month,
      previous_net_milliunits: previous.totals.net_spending_milliunits,
      net_milliunits: current.totals.net_spending_milliunits,
      change_milliunits: change,
      direction:
        change > 0 ? "increase" : change < 0 ? "decrease" : "unchanged",
      percent_change_basis_points: percent(
        change,
        previous.totals.net_spending_milliunits,
      ),
      category_changes: changes,
    };
  }
  const facts = {
    data_mode: first.data_mode,
    source: first.source,
    plan_id: args.plan_id,
    currency_code: first.currency_code,
    as_of: reports
      .map((r) => r.as_of)
      .sort()
      .at(-1),
    truncated: false as const,
    complete: true as const,
    method: "validated-spending-analysis-v1" as const,
    report_method: first.method,
    first_month: args.first_month,
    last_month: args.last_month,
    since_date: first.since_date,
    until_date: reports.at(-1)?.until_date,
    all_periods_closed: reports.every((r) => r.period_closed),
    source_transaction_count: count,
    zero_activity_categories_omitted:
      allCategories.length - activeCategories.length,
    totals,
    months: reports.map((r) => ({
      month: r.month,
      as_of: r.as_of,
      period_closed: r.period_closed,
      ...r.totals,
    })),
    categories: activeCategories,
    comparison,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(facts))
    .digest("hex");
  const cur = first.currency_code;
  let answer = `${facts.since_date} to ${facts.until_date} (${cur}). Net spending ${money(totals.net_spending_milliunits)} = gross category outflows ${money(totals.gross_outflow_milliunits)} less category credits ${money(totals.category_credit_milliunits)}. All ${reports.length} requested months reconciled. ${facts.all_periods_closed ? "Calendar periods closed; historical records may still change." : "Provisional: includes an open calendar period."} Income and credit-card payment bookkeeping excluded. Categorized tracking transfers included: ${money(totals.categorized_transfer_net_milliunits)}. Credits are not assumed to be refunds. Monthly snapshots are individually checked, not an atomic multi-month snapshot.`;
  if (comparison) {
    const p = comparison.percent_change_basis_points;
    const magnitude = p === null ? null : Math.abs(p);
    answer += ` ${comparison.month.slice(0, 7)} versus ${comparison.previous_month.slice(0, 7)}: ${comparison.direction}, change ${cur} ${money(comparison.change_milliunits)}${magnitude === null ? "; percentage unavailable for nonpositive baseline" : ` (${p !== null && p < 0 ? "-" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}% rounded to two decimals)`}. Category changes sum exactly to this change. These are observed category movements, not inferred purchase purposes.`;
  }
  const caption = `${facts.since_date} to ${facts.until_date} · Retrieved ${facts.as_of} · ${facts.all_periods_closed ? "Closed periods" : "Provisional open period"}`;
  const charts = [
    {
      kind: "monthly" as const,
      mime_type: "image/svg+xml" as const,
      svg: chartSvg(
        "Monthly net spending",
        cur,
        facts.months.map((m) => ({
          id: m.month,
          label: m.month.slice(0, 7),
          value: m.net_spending_milliunits,
        })),
        digest,
        caption,
      ),
    },
    {
      kind: "category" as const,
      mime_type: "image/svg+xml" as const,
      svg: chartSvg(
        "Period net spending by category",
        cur,
        activeCategories.map((c) => ({
          id: c.id,
          label: `${c.category_group_name} / ${c.name}`,
          value: c.net_spending_milliunits,
        })),
        digest,
        caption,
      ),
    },
  ];
  const resultCharts: z.infer<typeof outputSchema>["charts"] = charts;
  if (comparison)
    resultCharts.push({
      kind: "comparison",
      mime_type: "image/svg+xml",
      svg: chartSvg(
        `${comparison.month.slice(0, 7)} minus ${comparison.previous_month.slice(0, 7)} by category`,
        cur,
        comparison.category_changes.map((c) => ({
          id: c.id,
          label: c.name,
          value: c.change_milliunits,
        })),
        digest,
        caption,
        "No category changes; spending is unchanged.",
      ),
    });
  return outputSchema.parse({
    ...facts,
    evidence_digest: digest,
    canonical_answer: answer,
    charts: resultCharts,
  });
}

export type AnalysisInput = Input;
