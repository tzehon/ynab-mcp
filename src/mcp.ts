import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requestLog } from "./auth/request-context.js";
import type { Config } from "./config.js";
import { fixturePlanId } from "./tools/contracts.js";
import { errorResult } from "./tools/errors.js";
import * as month from "./tools/get-month.js";
import * as accounts from "./tools/list-accounts.js";
import * as categories from "./tools/list-categories.js";
import { inputSchema, listPlans, outputSchema } from "./tools/list-plans.js";
import * as transactions from "./tools/list-transactions.js";
import type { MockYnabClient } from "./ynab/client.js";
import { uuid } from "./ynab/contracts.js";
import type { LiveTools } from "./ynab/live-service.js";

export function createFixtureHandler(
  config: Config,
  client: MockYnabClient,
  live?: LiveTools,
) {
  const plan = live ? uuid : fixturePlanId;
  const context = {
    plan_id: plan,
    data_mode: live ? z.literal("live") : z.literal("fixtures"),
    source: live ? z.literal("ynab") : z.literal("mock-ynab"),
  };
  const run = <T>(work: (client: MockYnabClient) => Promise<T>) =>
    live ? live.run(work) : work(client);
  const plansSchema = live
    ? z.strictObject({
        data_mode: z.literal("live"),
        plans: z
          .array(
            z.strictObject({
              id: uuid,
              name: z.string().min(1).max(200),
              currency_code: z.string().regex(/^[A-Z]{3}$/),
            }),
          )
          .max(10),
        truncated: z.literal(false),
      })
    : outputSchema;
  return createMcpHandler(
    () => {
      const server = new McpServer({
        name: live ? "ynab-mcp" : "ynab-mcp-fixtures",
        version: "0.1.0",
      });
      server.registerTool(
        "ynab_list_plans",
        {
          description: live
            ? "List owner-selected YNAB plans. If empty, select plans on the service connection page."
            : "List only allowlisted invented fixture plans. No live YNAB data.",
          inputSchema,
          outputSchema: plansSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          requestLog("tool", 200, "ynab_list_plans");
          try {
            const output = live ? live.plans() : listPlans(config);
            return {
              structuredContent: output,
              content: [{ type: "text", text: JSON.stringify(output) }],
            };
          } catch (error) {
            return errorResult(error);
          }
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
          description: live
            ? "List accounts from a selected YNAB plan with exact integer milliunits and currency context."
            : "List invented accounts with exact integer milliunits and synthetic currency context.",
          inputSchema: accounts.inputSchema.safeExtend({ plan_id: plan }),
          outputSchema: accounts.outputSchema.safeExtend(context),
          annotations,
        },
        async (args, ctx) => {
          try {
            return await run((c) =>
              accounts.listAccounts(c, args, ctx.mcpReq.signal),
            );
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
          description: live
            ? "Read a YNAB month summary; no totals are inferred from transactions."
            : "Read a mocked month summary; no totals are inferred from transactions.",
          inputSchema: month.inputSchema.safeExtend({ plan_id: plan }),
          outputSchema: month.outputSchema.safeExtend(context),
          annotations,
        },
        async (args, ctx) => {
          try {
            return await run((c) => month.getMonth(c, args, ctx.mcpReq.signal));
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
          description: live
            ? "List YNAB category metadata only, without current-month balances or goals."
            : "List invented category metadata only, without current-month balances or goals.",
          inputSchema: categories.inputSchema.safeExtend({ plan_id: plan }),
          outputSchema: categories.outputSchema.safeExtend(context),
          annotations,
        },
        async (args, ctx) => {
          try {
            return await run((c) =>
              categories.listCategories(c, args, ctx.mcpReq.signal),
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
          description: live
            ? "Read non-pending YNAB transactions in an inclusive window of at most 90 days. Splits remain nested; transfers are not spending totals. If truncated, narrow the window or increase limit to 100; no pagination or complete retrieval guarantee."
            : "Read invented non-pending transactions in an inclusive window of at most 90 days. Splits remain nested, transfers are not spending totals. If truncated, narrow the date window or increase limit up to 100; no pagination or complete retrieval guarantee.",
          inputSchema: transactions.inputSchema.safeExtend({ plan_id: plan }),
          outputSchema: transactions.outputSchema.safeExtend(context),
          annotations,
        },
        async (args, ctx) => {
          try {
            return await run((c) =>
              transactions.listTransactions(c, args, ctx.mcpReq.signal),
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
