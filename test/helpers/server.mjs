import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { parseConfig } from "../../dist/config.js";
import { createFixtureHttp } from "../../dist/http.js";
import { fixtureEnv, unusedPort, portEnv, tokenFor } from './auth.mjs';
export { fixtureEnv } from './auth.mjs';
export async function serve(t, env = {}, catalog, transport, authTransport, observeProtocol) {
  const port = await unusedPort();
  const app = createFixtureHttp(
    parseConfig({ ...fixtureEnv, ...portEnv(port), ...env }, catalog),
    transport,
    authTransport,
    observeProtocol,
  );
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => app.close());
  return {
    ...app,
    port: app.server.address().port,
    url: `http://127.0.0.1:${app.server.address().port}/mcp`,
  };
}
export async function connect(t, url, era = "legacy", observe = () => {}) {
  const c = new Client(
    { name: "synthetic-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (u, o = {}) => {
      const parsed = o.body ? JSON.parse(o.body) : {};
      const headers = new Headers(o.headers);
      headers.set("Authorization", `Bearer ${tokenFor(new URL(url).port)}`);
      const r = await fetch(u, {
        ...o,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const contentType = r.headers.get("content-type");
      observe(parsed, r, contentType);
      return r;
    },
  });
  t.after(() => c.close());
  await c.connect(transport);
  return c;
}
