import { AsyncLocalStorage } from "node:async_hooks";
import { ToolError } from "../tools/errors.js";
// Private capability only; raw bearer and identity claims never enter SDK/log context.
export const authorizationContext = new AsyncLocalStorage<() => void>();
export function requireCurrentAuthorization() {
  try {
    const check = authorizationContext.getStore();
    if (!check) throw new Error();
    check();
  } catch {
    throw new ToolError("UPSTREAM_UNAUTHORIZED");
  }
}
