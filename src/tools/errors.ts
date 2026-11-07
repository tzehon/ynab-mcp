export const messages = Object.freeze({
  INVALID_ARGUMENTS: "Invalid tool arguments.",
  PLAN_NOT_ALLOWED: "Plan is not allowed.",
  NOT_FOUND: "Requested data was not found.",
  UPSTREAM_UNAUTHORIZED: "Mock upstream authorization failed.",
  UPSTREAM_FORBIDDEN: "Mock upstream access was denied.",
  UPSTREAM_RATE_LIMITED: "Mock upstream rate limit reached.",
  UPSTREAM_UNAVAILABLE: "Mock upstream is unavailable.",
  UPSTREAM_TIMEOUT: "Mock upstream operation did not complete.",
  UPSTREAM_RESPONSE_TOO_LARGE: "Mock upstream response exceeds limits.",
  UPSTREAM_INVALID_RESPONSE: "Mock upstream response is invalid.",
  UPSTREAM_FAILURE: "Mock upstream request failed.",
  RESULT_TOO_LARGE: "Tool result exceeds limits.",
  BUSY: "Adapter capacity is busy.",
  INTERNAL_ERROR: "Tool operation failed.",
});
export type ErrorCode = keyof typeof messages;
export class ToolError extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
  }
}
export function errorResult(error: unknown) {
  const code = error instanceof ToolError ? error.code : "INTERNAL_ERROR";
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message: messages[code] } }),
      },
    ],
  };
}
export function canonicalError(value: Record<string, unknown>) {
  if (
    value.structuredContent !== undefined ||
    !Array.isArray(value.content) ||
    value.content.length !== 1
  )
    return;
  const block = value.content[0];
  if (
    !block ||
    Object.keys(block).sort().join() !== "text,type" ||
    block.type !== "text" ||
    typeof block.text !== "string"
  )
    return;
  try {
    const data = JSON.parse(block.text);
    if (
      !data ||
      Object.keys(data).join() !== "error" ||
      !data.error ||
      Object.keys(data.error).sort().join() !== "code,message"
    )
      return;
    const { code, message } = data.error;
    if (
      typeof code !== "string" ||
      !Object.hasOwn(messages, code) ||
      message !== messages[code as ErrorCode]
    )
      return;
    return errorResult(new ToolError(code as ErrorCode));
  } catch {
    return;
  }
}
