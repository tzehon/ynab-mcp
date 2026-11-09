import { parseConfig } from "./config.js";
import { ConfigError, operationalLog } from "./errors.js";
import { createHostedHttp } from "./hosted-http.js";
import { createFixtureHttp } from "./http.js";

try {
  const config = parseConfig(process.env);
  const app = config.hosted
    ? await createHostedHttp(config)
    : createFixtureHttp(config);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 4500);
    deadline.unref();
    try {
      await app.close();
      operationalLog("SHUTDOWN");
      clearTimeout(deadline);
    } catch {
      operationalLog("HTTP_FAILED");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  app.server.once("error", () => {
    operationalLog("START_FAILED");
    void shutdown();
    process.exitCode = 1;
  });
  app.server.listen(config.port, config.host, () =>
    operationalLog("LISTENING", config.port),
  );
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "START_FAILED");
  process.exitCode = 1;
}
