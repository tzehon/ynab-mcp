import { pathToFileURL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  accountsOutput,
  monthOutput,
  categoriesOutput,
  transactionsOutput,
} from "../dist/tools/contracts.js";
import { outputSchema as analysisOutput } from "../dist/tools/get-spending-analysis.js";
import { outputSchema as spendingOutput } from "../dist/tools/get-spending-report.js";
import { outputSchema } from "../dist/tools/list-plans.js";

export function parseTarget(value) {
  const match =
    typeof value === "string" &&
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]*)\/mcp$/.exec(value);
  if (!match || Number(match[1]) > 65535)
    throw new Error("INVALID_SMOKE_TARGET");
  return new URL(value);
}
export async function runSmoke(value, report = () => {}, token) {
  if (
    typeof token !== "string" ||
    !token ||
    Buffer.byteLength(token) > 8192 ||
    /\s/.test(token)
  )
    throw new Error("INVALID_SMOKE_TOKEN");
  const url = parseTarget(value);
  const whole = AbortSignal.timeout(20000);
  const requestOptions = {
    signal: whole,
    timeout: 5000,
    maxTotalTimeout: 5000,
  };
  for (const era of ["legacy", "modern"]) {
    const client = new Client(
      { name: "ynab-fixture-smoke", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: (input, init = {}) => {
        const target = new URL(input instanceof Request ? input.url : input);
        if (target.href !== url.href) throw new Error("INVALID_SMOKE_TARGET");
        // URL normalizes explicit :80 away, but the local server deliberately
        // requires the exact authority including its listening port.
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("Host", `127.0.0.1:${url.port || "80"}`);
        return fetch(input, {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.any([
            whole,
            AbortSignal.timeout(5000),
            ...(init.signal ? [init.signal] : []),
          ]),
        });
      },
    });
    try {
      await client.connect(transport, requestOptions);
      if (client.getProtocolEra() !== era)
        throw new Error("WRONG_PROTOCOL_ERA");
      const { tools } = await client.listTools(undefined, requestOptions);
      if (
        tools.length !== 7 ||
        tools[0].name !== "ynab_list_plans" ||
        tools[0].annotations?.readOnlyHint !== true ||
        !tools[0].outputSchema
      )
        throw new Error("INVALID_TOOL_CATALOG");
      const result = await client.callTool(
        {
          name: "ynab_list_plans",
          arguments: {},
        },
        requestOptions,
      );
      if (result.isError) throw new Error("TOOL_FAILED");
      const output = outputSchema.parse(result.structuredContent);
      if (
        result.content.length !== 1 ||
        result.content[0].type !== "text" ||
        JSON.stringify(JSON.parse(result.content[0].text)) !==
          JSON.stringify(output)
      )
        throw new Error("INVALID_TOOL_OUTPUT");
      const plan =
        output.plans.find((p) => p.id === "fixture-plan-sgd") ??
        output.plans.find((p) => p.id === "fixture-plan-usd");
      if (!plan) throw new Error("NO_SMOKE_PLAN");
      for (const [name, schema, extra] of [
        ["ynab_list_accounts", accountsOutput, {}],
        ["ynab_get_month", monthOutput, { month: "2026-11-01" }],
        ["ynab_get_spending_report", spendingOutput, { month: "2026-11-01" }],
        [
          "ynab_get_spending_analysis",
          analysisOutput,
          {
            first_month: "2026-11-01",
            last_month: "2026-11-01",
            include_open_month: true,
          },
        ],
        ["ynab_list_categories", categoriesOutput, {}],
        [
          "ynab_list_transactions",
          transactionsOutput,
          { since_date: "2026-11-01", until_date: "2026-11-07" },
        ],
      ]) {
        const tool = tools.find((t) => t.name === name);
        if (!tool?.outputSchema || tool.annotations?.readOnlyHint !== true)
          throw new Error("INVALID_TOOL_CATALOG");
        const result = await client.callTool(
          { name, arguments: { plan_id: plan.id, ...extra } },
          requestOptions,
        );
        if (result.isError) throw new Error("TOOL_FAILED");
        const data = schema.parse(result.structuredContent);
        if (
          result.content.length !== 1 ||
          result.content[0].type !== "text" ||
          JSON.stringify(JSON.parse(result.content[0].text)) !==
            JSON.stringify(data)
        )
          throw new Error("INVALID_TOOL_OUTPUT");
      }
      report(era);
    } finally {
      await client.close();
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--url")
      throw new Error("INVALID_ARGUMENTS");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 8193)
        throw new Error("INVALID_SMOKE_TOKEN");
    }
    const token = input.endsWith("\n") ? input.slice(0, -1) : input;
    await runSmoke(
      process.argv[3],
      (era) => console.log(`MCP_SMOKE_PASS ${era}`),
      token,
    );
  } catch {
    console.error("MCP_SMOKE_FAILED");
    process.exitCode = 1;
  }
}
