export const ORIGIN = "https://api.ynab.com";
export type Operation = "accounts" | "month" | "categories" | "transactions";
export type MockRequest = Readonly<{
  method: "GET";
  origin: typeof ORIGIN;
  path: string;
  query: Readonly<Record<string, string>>;
}>;
export type MockResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}>;
export type MockTransport = (
  request: MockRequest,
  signal: AbortSignal,
) => Promise<MockResponse>;
export function descriptor(
  operation: Operation,
  mappedId: string,
  args: { month?: string; since_date?: string; until_date?: string },
): MockRequest {
  const query: Record<string, string> =
    operation === "transactions"
      ? {
          since_date: args.since_date as string,
          until_date: args.until_date as string,
        }
      : {};
  return Object.freeze({
    method: "GET",
    origin: ORIGIN,
    path: `/v1/plans/${mappedId}/${operation === "month" ? `months/${args.month}` : operation}`,
    query: Object.freeze(query),
  });
}
