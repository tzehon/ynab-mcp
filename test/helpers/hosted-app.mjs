import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { parseConfig } from "../../dist/config.js";
import { createHostedHttp } from "../../dist/hosted-http.js";
import { Store } from "../../dist/oauth/store.js";
import { hostedKeys } from "../../dist/oauth/hosted-keys.js";
import { Enrollment } from "../../dist/oauth/enrollment.js";
import { providerHarness } from "./hosted-provider.mjs";
export async function hostedApp(
  t,
  { bootstrap = false, method = "client_secret_post" } = {},
) {
  const h = await providerHarness(t),
    dir = join(h.root, "app-state"),
    runtime = join(h.root, "runtime");
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const owner = "11111111-1111-4111-8111-111111111111",
    hex = () => randomBytes(32).toString("hex");
  const { privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const raw = JSON.stringify({
    encryption: hex(),
    lookup: hex(),
    cookie: hex(),
    signing: [
      {
        ...(await exportJWK(privateKey)),
        kid: "fixture-active",
        use: "sig",
        alg: "RS256",
      },
    ],
  });
  // Private setup is exercised separately; this test begins with a confirmed
  // synthetic owner, using the same Enrollment service (not a magic flag).
  if (!bootstrap) {
    const s = new Store(dir, hostedKeys(raw));
    s.put("HostedSchema", "mode", { version: 1 }, Number.MAX_SAFE_INTEGER);
    const c = {
      kind: "enroll",
      capability: hex(),
      issuance: "fixture-issuance",
      expires: Date.now() + 900000,
    };
    const enrollment = new Enrollment(s, c),
      flow = enrollment.claim(c.capability, "fixture-browser");
    enrollment.candidate(flow, "fixture-browser", owner);
    enrollment.confirm(owner);
    s.close();
  }
  const e = {
    AUTH_MODE: "integrated-hosted",
    HOSTED_AUTHORIZATION_ENABLED: "true",
    NODE_ENV: "production",
    DATA_MODE: "fixtures",
    PORT: "3000",
    AUTH_ISSUER: "https://fixture-host.up.railway.app",
    AUTH_AUDIENCE: "https://fixture-host.up.railway.app/mcp",
    MCP_PUBLIC_URL: "https://fixture-host.up.railway.app/mcp",
    AUTH_ALLOWED_SUBJECT: owner,
    OAUTH_STATE_DIR: "/data/authorization",
    OAUTH_KEY_BUNDLE: raw,
    OAUTH_NATIVE_CLIENT_ID: "fixture-native",
    OAUTH_WEB_CLIENT_ID: "fixture-web",
    OAUTH_NATIVE_CALLBACK: "http://127.0.0.1:9876/callback",
    OAUTH_WEB_CALLBACK: "https://client.example/callback",
    OAUTH_WEB_AUTH_METHOD: method,
    OAUTH_WEB_SECRET: hex(),
    YNAB_CLIENT_ID: "fixture-upstream",
    YNAB_CLIENT_SECRET: hex(),
    FIXTURE_ALLOWED_PLAN_IDS: '["fixture-plan-sgd"]',
  };
  if (bootstrap) {
    delete e.AUTH_ALLOWED_SUBJECT;
    Object.assign(e, {
      OAUTH_ENROLLMENT_ID: "fixture-issuance",
      OAUTH_ENROLLMENT_CAPABILITY: hex(),
      OAUTH_ENROLLMENT_EXPIRES: String(Date.now() + 900000),
    });
  }
  const parsed = parseConfig(e);
  // Only the test factory changes local listener/store locations. No such env
  // override is accepted by parseConfig or the executable entry point.
  const config = {
    ...parsed,
    hosted: { ...parsed.hosted, origin: h.origin, dir, runtimeDir: runtime },
    auth: { ...parsed.auth, issuer: h.origin, audience: `${h.origin}/mcp` },
  };
  const seen = [],
    control = { owner, tokenStatus: 200 };
  const provider = createServer(
    {
      cert: readFileSync(join(h.root, "cert")),
      key: readFileSync(join(h.root, "key")),
    },
    (req, res) => {
      req.resume();
      seen.push(`https://${req.headers.host}${req.url}`);
      res.setHeader("content-type", "application/json");
      if (
        req.headers.host === "app.ynab.com" &&
        req.url === "/oauth/token" &&
        req.method === "POST"
      ) {
        res.statusCode = control.tokenStatus;
        res.end(
          JSON.stringify({
            access_token: "invented-upstream-access",
            refresh_token: "invented-upstream-refresh",
            expires_in: 3600,
            token_type: "bearer",
            scope: "read-only",
          }),
        );
      } else if (
        req.headers.host === "api.ynab.com" &&
        req.url === "/v1/user" &&
        req.method === "GET"
      ) {
        res.end(JSON.stringify({ data: { user: { id: control.owner } } }));
      } else {
        res.statusCode = 403;
        res.end("{}");
      }
    },
  );
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const upstream = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(String(input));
      assert(["app.ynab.com", "api.ynab.com"].includes(u.hostname));
      assert.equal(u.protocol, "https:");
      assert.equal(init.redirect, "manual");
      const req = request(
        {
          hostname: "127.0.0.1",
          servername: "",
          port: provider.address().port,
          path: u.pathname,
          method: init.method,
          ca: readFileSync(join(h.root, "cert")),
          signal: init.signal,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            host: u.hostname,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(init.body?.toString());
    });
  let app = await createHostedHttp(config, upstream);
  h.beforeCleanup(async () => {
    await app.close();
    await new Promise((r) => provider.close(r));
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  // Actual TLS termination/proxy into the production HTTP listener. Preserve
  // duplicate raw headers so the application, not just the proxy, must reject them.
  h.setHandler((req, res) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: app.server.address().port,
        path: req.url,
        method: req.method,
        headers: req.rawHeaders,
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.destroy();
    });
    req.pipe(upstream);
  });
  return {
    h,
    e,
    config,
    seen,
    control,
    app,
    dir,
    runtime,
    owner,
    raw,
    restart: async (hostedOverrides = {}) => {
      await app.close();
      app = await createHostedHttp(
        { ...config, hosted: { ...config.hosted, ...hostedOverrides } },
        upstream,
      );
      await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
      return app;
    },
  };
}
