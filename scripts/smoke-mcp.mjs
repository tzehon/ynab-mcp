import { pathToFileURL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { outputSchema } from "../dist/tools/list-plans.js";

export function parseTarget(value) {
  const match =
    typeof value === "string" &&
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]*)\/mcp$/.exec(value);
  if (!match || Number(match[1]) > 65535)
    throw new Error("INVALID_SMOKE_TARGET");
  return new URL(value);
}
export async function runSmoke(value, report = () => {}) {
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
        tools.length !== 1 ||
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
    await runSmoke(process.argv[3], (era) =>
      console.log(`MCP_SMOKE_PASS ${era}`),
    );
  } catch {
    console.error("MCP_SMOKE_FAILED");
    process.exitCode = 1;
  }
}
