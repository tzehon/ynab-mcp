import type {
  Analysis,
  presentationRuntime,
} from "../tools/analysis-presentation.js";
export type JsonSchema = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
};
// Serialized into the view as a closed function; only repository-owned schemas/code
// are supplied. Reports are bounded data, never executable code or HTML.
export function validationRuntime(
  schema: JsonSchema,
  inputSchema: JsonSchema,
  presentation: ReturnType<typeof presentationRuntime>,
) {
  function fail(): never {
    throw new Error("No complete validated spending view is available.");
  }
  function check(s: JsonSchema, v: unknown): void {
    if (s.anyOf) {
      if (
        !s.anyOf.some((alternative) => {
          try {
            check(alternative, v);
            return true;
          } catch {
            return false;
          }
        })
      )
        fail();
      return;
    }
    if (Object.hasOwn(s, "const") && v !== s.const) fail();
    if (s.enum && !s.enum.includes(v)) fail();
    if (s.type === "null") {
      if (v !== null) fail();
    } else if (s.type === "object") {
      if (!v || typeof v !== "object" || Array.isArray(v)) fail();
      const obj = v as Record<string, unknown>;
      if (s.required?.some((k) => !Object.hasOwn(obj, k))) fail();
      for (const k of Object.keys(obj)) {
        if (!Object.hasOwn(s.properties ?? {}, k)) fail();
        check(s.properties?.[k] ?? {}, obj[k]);
      }
    } else if (s.type === "array") {
      if (
        !Array.isArray(v) ||
        v.length < (s.minItems ?? 0) ||
        v.length > (s.maxItems ?? 100)
      )
        fail();
      for (const x of v) check(s.items ?? {}, x);
    } else if (s.type === "string") {
      if (
        typeof v !== "string" ||
        v.length < (s.minLength ?? 0) ||
        v.length > (s.maxLength ?? 65536) ||
        (s.pattern && !new RegExp(s.pattern).test(v))
      )
        fail();
    } else if (s.type === "integer") {
      if (
        typeof v !== "number" ||
        !Number.isSafeInteger(v) ||
        v < (s.minimum ?? Number.MIN_SAFE_INTEGER) ||
        v > (s.maximum ?? Number.MAX_SAFE_INTEGER)
      )
        fail();
    } else if (s.type === "boolean" && typeof v !== "boolean") fail();
  }
  function ordered(s: JsonSchema, v: unknown): unknown {
    if (s.type === "object")
      return Object.fromEntries(
        Object.keys(s.properties ?? {})
          .filter((k) => Object.hasOwn(v as object, k))
          .map((k) => [
            k,
            ordered(s.properties?.[k] ?? {}, (v as Record<string, unknown>)[k]),
          ]),
      );
    if (s.type === "array")
      return (v as unknown[]).map((x) => ordered(s.items ?? {}, x));
    // Nullable comparison has anyOf; find its concrete object shape.
    if (s.anyOf && v !== null) {
      const object = s.anyOf.find((x) => x.type === "object");
      if (object) return ordered(object, v);
    }
    return v;
  }
  function month(value: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)) fail();
    return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
  }
  async function validate(value: unknown, request: unknown): Promise<Analysis> {
    if (
      new TextEncoder().encode(JSON.stringify(value)).length > 65536 ||
      new TextEncoder().encode(JSON.stringify(request)).length > 1024
    )
      fail();
    check(schema, value);
    check(inputSchema, request);
    const r = value as Analysis;
    const args = request as {
      plan_id: string;
      first_month: string;
      last_month: string;
      comparison_month?: string;
      include_open_month?: boolean;
    };
    if (
      r.plan_id !== args.plan_id ||
      r.first_month !== args.first_month ||
      r.last_month !== args.last_month ||
      (r.data_mode === "live" ? r.source !== "ynab" : r.source !== "mock-ynab")
    )
      fail();
    const first = month(r.first_month),
      last = month(r.last_month);
    if (
      last < first ||
      last - first > 5 ||
      r.months.length !== last - first + 1 ||
      r.since_date !== r.first_month
    )
      fail();
    const next = new Date(`${r.last_month}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    if (r.until_date !== next.toISOString().slice(0, 10)) fail();
    if (
      r.months.some((m, i) => month(m.month) !== first + i) ||
      r.all_periods_closed !== r.months.every((m) => m.period_closed) ||
      (!r.all_periods_closed && args.include_open_month !== true)
    )
      fail();
    if (
      args.comparison_month &&
      (month(args.comparison_month) <= first ||
        month(args.comparison_month) > last)
    )
      fail();
    const comparisonMonth =
      last > first ? (args.comparison_month ?? args.last_month) : undefined;
    if (!!r.comparison !== !!comparisonMonth) fail();
    if (
      r.comparison &&
      (r.comparison.month !== comparisonMonth ||
        month(r.comparison.month) <= first ||
        month(r.comparison.month) > last ||
        month(r.comparison.previous_month) !== month(r.comparison.month) - 1)
    )
      fail();
    if (
      new Set(r.categories.map((c) => c.id)).size !== r.categories.length ||
      (r.comparison &&
        new Set(r.comparison.category_changes.map((c) => c.id)).size !==
          r.comparison.category_changes.length)
    )
      fail();
    const canonical = ordered(schema, r) as Analysis;
    const { evidence_digest, canonical_answer, charts, ...facts } = canonical;
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(facts)),
    );
    const digest = Array.from(new Uint8Array(bytes), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== evidence_digest) fail();
    const expected = presentation.present(facts, digest);
    // Exact equality to the shared inert SVG generator verifies every label,
    // signed amount and attribute, and rejects active/external SVG content.
    if (
      canonical_answer !== expected.canonical_answer ||
      JSON.stringify(charts) !== JSON.stringify(expected.charts)
    )
      fail();
    return r;
  }
  return { validate, format: presentation.money };
}
