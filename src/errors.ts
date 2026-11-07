export class ConfigError extends Error {
  constructor(setting: string) {
    super(`CONFIG_${setting}`);
  }
}
export function operationalLog(
  code: "LISTENING" | "SHUTDOWN" | "START_FAILED" | "HTTP_FAILED",
  port?: number,
) {
  console.error(
    JSON.stringify({ code, ...(port === undefined ? {} : { port }) }),
  );
}
