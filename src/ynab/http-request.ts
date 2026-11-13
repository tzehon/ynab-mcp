import { ToolError } from "../tools/errors.js";
import { uuid, validDate } from "./contracts.js";
import { ORIGIN } from "./transport.js";

const invalid = () => new ToolError("INVALID_ARGUMENTS");

// Read data properties only; accessors and unexpected own keys are not input.
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw invalid();
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) throw invalid();
    copy[key] = field.value;
  }
  return copy;
}

export function mappedAllowlist(value: readonly string[]): ReadonlySet<string> {
  try {
    if (!Array.isArray(value)) throw invalid();
    const copy = new Set<string>();
    for (const entry of value) {
      if (
        typeof entry !== "string" ||
        entry.length !== 36 ||
        !uuid.safeParse(entry).success
      )
        throw invalid();
      copy.add(entry.toLowerCase());
    }
    return copy;
  } catch {
    throw invalid();
  }
}

export function httpRequest(
  value: unknown,
  allowed: ReadonlySet<string>,
): string {
  let path: string;
  let plan: string;
  let search: URLSearchParams;
  try {
    const input = record(value);
    if (
      Object.keys(input).sort().join() !== "method,origin,path,query" ||
      input.method !== "GET" ||
      input.origin !== ORIGIN ||
      typeof input.path !== "string"
    )
      throw invalid();
    const match =
      /^\/v1\/plans\/([0-9a-f-]+)\/(accounts|categories|transactions|months\/(20\d{2}-\d{2}-\d{2}))$/i.exec(
        input.path,
      );
    if (!match || match[0] !== input.path || !uuid.safeParse(match[1]).success)
      throw invalid();
    // UUIDs are case-insensitive; route and date syntax are exact.
    plan = match[1] as string;
    const operation = match[2];
    if (
      !operation ||
      !/^(accounts|categories|transactions|months\/20\d{2}-\d{2}-\d{2})$/.test(
        operation,
      )
    )
      throw invalid();
    if (match[3] && (!validDate(match[3]) || !match[3].endsWith("-01")))
      throw invalid();
    const query = record(input.query);
    search = new URLSearchParams();
    if (operation === "transactions") {
      if (Object.keys(query).sort().join() !== "since_date,until_date")
        throw invalid();
      const { since_date: since, until_date: until } = query;
      if (
        typeof since !== "string" ||
        typeof until !== "string" ||
        !validDate(since) ||
        !validDate(until)
      )
        throw invalid();
      const days = (Date.parse(until) - Date.parse(since)) / 86400000 + 1;
      if (days < 1 || days > 90) throw invalid();
      search.set("since_date", since);
      search.set("until_date", until);
    } else if (Object.keys(query).length !== 0) throw invalid();
    path = input.path;
  } catch {
    throw invalid();
  }
  if (!allowed.has(plan.toLowerCase())) throw new ToolError("PLAN_NOT_ALLOWED");
  const suffix = search.toString();
  return `${ORIGIN}${path}${suffix ? `?${suffix}` : ""}`;
}
