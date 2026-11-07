import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { inputSchema, outputSchema, listPlans } from "./tools/list-plans.js";

export function createFixtureHandler(config: Config) {
  return createMcpHandler(
    () => {
      const server = new McpServer({
        name: "ynab-mcp-fixtures",
        version: "0.1.0",
      });
      server.registerTool(
        "ynab_list_plans",
        {
          description:
            "List only allowlisted invented fixture plans. No live YNAB data.",
          inputSchema,
          outputSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          const output = listPlans(config);
          return {
            structuredContent: output,
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        },
      );
      return server;
    },
    { legacy: "stateless", responseMode: "json", maxRequestBodySize: 65536 },
  );
}
