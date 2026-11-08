import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
export const requestContext = new AsyncLocalStorage<{
  id: string;
  started: number;
}>();
export function newRequestContext() {
  return { id: randomUUID(), started: performance.now() };
}
export function requestLog(
  stage: "auth" | "tool",
  status: number,
  tool?: string,
) {
  const context = requestContext.getStore();
  if (!context) return;
  console.error(
    JSON.stringify({
      request_id: context.id,
      stage,
      status,
      duration_ms: Math.max(0, Math.round(performance.now() - context.started)),
      ...(tool ? { tool } : {}),
    }),
  );
}
