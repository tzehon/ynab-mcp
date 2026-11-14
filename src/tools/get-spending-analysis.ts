import type { MockYnabClient } from "../ynab/client.js";
import { success } from "./contracts.js";
import { ToolError } from "./errors.js";
import { getSpendingReport } from "./get-spending-report.js";
import {
  compileAnalysis,
  requestedMonths,
  outputSchema,
} from "./spending-analysis.js";
export { inputSchema, outputSchema } from "./spending-analysis.js";

export async function getSpendingAnalysis(
  client: MockYnabClient,
  value: unknown,
  signal?: AbortSignal,
) {
  const { args, months } = requestedMonths(value);
  client.context(args.plan_id);
  const deadline = performance.now() + 9000;
  const timeout = AbortSignal.timeout(9000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const check = () => {
    if (abort.aborted || performance.now() >= deadline)
      throw new ToolError("UPSTREAM_TIMEOUT");
    client.context(args.plan_id);
  };
  const reports: unknown[] = [];
  for (const month of months) {
    check();
    const report = await getSpendingReport(
      client,
      { plan_id: args.plan_id, month },
      abort,
    );
    reports.push(report.structuredContent);
  }
  check();
  const result = success(outputSchema, compileAnalysis(args, reports));
  check();
  return result;
}
