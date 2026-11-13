import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requestLog } from "./auth/request-context.js";
import type { Config } from "./config.js";
import { fixturePlanId } from "./tools/contracts.js";
import { errorResult } from "./tools/errors.js";
import * as spending from "./tools/get-spending-report.js";
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
      const server = new McpServer(
        {
          name: live ? "ynab-mcp" : "ynab-mcp-fixtures",
          version: "0.2.0",
        },
        {
          instructions:
            "For spending charts or category comparisons, call ynab_get_spending_report for each requested month. Never treat ynab_get_month activity as spending: it includes credit-card payment bookkeeping. Use only reconciled reports; do not substitute partial transaction totals after a failure. Preserve negative net values/credits, exact dates and currency; 1000 milliunits = one currency unit. Explain categorized tracking transfers separately from purchases. Use cursor pages for drill-down; never infer refund purpose from a positive amount alone.",
        },
      );
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
            openWorldHint: !!live,
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
        openWorldHint: !!live,
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
            ? "Read raw YNAB budget activity and category detail. activity_milliunits includes credit-card payment bookkeeping and is NOT spending. Use ynab_get_spending_report for spending calculations and charts."
            : "Read raw mocked budget activity, NOT spending. Use ynab_get_spending_report for spending calculations.",
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
            ? "Read non-pending YNAB transactions in an inclusive window of at most 90 days. Splits remain nested; transfers are not spending totals. Follow next_cursor until null; restart on STALE_CURSOR. Max 1000 upstream rows and bounded bytes; no unbounded-history guarantee. Use ynab_get_spending_report for totals."
            : "Read invented non-pending transactions in an inclusive window of at most 90 days. Splits remain nested, transfers are not spending totals. Follow next_cursor until null; restart on STALE_CURSOR. Bounded upstream history; use ynab_get_spending_report for totals.",
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
      server.registerTool(
        "ynab_get_spending_report",
        {
          description:
            "Compute an exact, reconciled monthly spending report from YNAB transactions and month categories. Use for spending charts and comparisons, not raw budget activity. month is YYYY-MM-01; call for each requested month. Returns gross outflows, category credits, net spending, separate credit-card bookkeeping and categorized tracking transfers. All amounts are integer milliunits (1000 = one currency unit). Refuses inconsistent/oversized data; never substitute partial totals. Check period_closed for unfinished months. Up to 1000 source transactions; pending excluded.",
          inputSchema: spending.inputSchema.safeExtend({ plan_id: plan }),
          outputSchema: spending.outputSchema.safeExtend(context),
          annotations,
        },
        async (args, ctx) => {
          try {
            return await run((c) =>
              spending.getSpendingReport(c, args, ctx.mcpReq.signal),
            );
          } catch (e) {
            return errorResult(e);
          } finally {
            requestLog("tool", 200, "ynab_get_spending_report");
          }
        },
      );
      return server;
    },
    { legacy: "stateless", responseMode: "json", maxRequestBodySize: 65536 },
  );
}
