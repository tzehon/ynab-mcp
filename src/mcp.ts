import { requestLog } from "./auth/request-context.js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { MockYnabClient } from "./ynab/client.js";
import * as accounts from "./tools/list-accounts.js";
import * as month from "./tools/get-month.js";
import * as categories from "./tools/list-categories.js";
import * as transactions from "./tools/list-transactions.js";
import { errorResult } from "./tools/errors.js";
import type { Config } from "./config.js";
import { inputSchema, outputSchema, listPlans } from "./tools/list-plans.js";

export function createFixtureHandler(config: Config, client: MockYnabClient) {
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
          requestLog("tool", 200, "ynab_list_plans");
          const output = listPlans(config);
          return {
            structuredContent: output,
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        },
      );
      const annotations = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      };
      server.registerTool(
        "ynab_list_accounts",
        {
          description:
            "List invented accounts with exact integer milliunits and synthetic currency context.",
          inputSchema: accounts.inputSchema,
          outputSchema: accounts.outputSchema,
          annotations,
        },
        async (args, ctx) => {
          try {
            return await accounts.listAccounts(client, args, ctx.mcpReq.signal);
          } catch (e) {
            return errorResult(e);
          } finally {
            requestLog("tool", 200, "ynab_list_accounts");
          }
        },
      );
      server.registerTool(
        "ynab_get_month",
        {
          description:
            "Read a mocked month summary; no totals are inferred from transactions.",
          inputSchema: month.inputSchema,
          outputSchema: month.outputSchema,
          annotations,
        },
        async (args, ctx) => {
          try {
            return await month.getMonth(client, args, ctx.mcpReq.signal);
          } catch (e) {
            return errorResult(e);
          } finally {
            requestLog("tool", 200, "ynab_get_month");
          }
        },
      );
      server.registerTool(
        "ynab_list_categories",
        {
          description:
            "List invented category metadata only, without current-month balances or goals.",
          inputSchema: categories.inputSchema,
          outputSchema: categories.outputSchema,
          annotations,
        },
        async (args, ctx) => {
          try {
            return await categories.listCategories(
              client,
              args,
              ctx.mcpReq.signal,
            );
          } catch (e) {
            return errorResult(e);
          } finally {
            requestLog("tool", 200, "ynab_list_categories");
          }
        },
      );
      server.registerTool(
        "ynab_list_transactions",
        {
          description:
            "Read invented non-pending transactions in an inclusive window of at most 90 days. Splits remain nested, transfers are not spending totals. If truncated, narrow the date window or increase limit up to 100; no pagination or complete retrieval guarantee.",
          inputSchema: transactions.inputSchema,
          outputSchema: transactions.outputSchema,
          annotations,
        },
        async (args, ctx) => {
          try {
            return await transactions.listTransactions(
              client,
              args,
              ctx.mcpReq.signal,
            );
          } catch (e) {
            return errorResult(e);
          } finally {
            requestLog("tool", 200, "ynab_list_transactions");
          }
        },
      );
      return server;
    },
    { legacy: "stateless", responseMode: "json", maxRequestBodySize: 65536 },
  );
}
