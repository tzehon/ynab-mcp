import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { parseConfig } from "../../dist/config.js";
import { createFixtureHttp } from "../../dist/http.js";
import { mockYnab } from "../../scripts/lib/mock-ynab-provider.mjs";
export async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
export class Browser {
  cookies = new Map();
  async fetch(url, options = {}) {
    const u = new URL(url);
    const cs = [...this.cookies.values()]
      .filter((c) => c.host === u.hostname && u.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const r = await fetch(url, {
      redirect: "manual",
      ...options,
      headers: { cookie: cs, ...options.headers },
    });
    for (const raw of r.headers.getSetCookie()) {
      const parts = raw.split(";").map((v) => v.trim());
      const [name, ...value] = parts[0].split("=");
      const path = parts.find((v) => /^path=/i.test(v))?.slice(5) ?? "/";
      this.cookies.set(`${u.hostname}:${path}:${name}`, {
        host: u.hostname,
        path,
        name,
        value: value.join("="),
      });
    }
    return r;
  }
  async form(url, decision) {
    const r = await this.fetch(url),
      text = await r.text();
    const csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1];
    if (!csrf) throw new Error(`FORM_${r.status}`);
    return this.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(url).origin,
      },
      body: new URLSearchParams({
        csrf,
        decision,
        ...(text.match(/name="flow_id" value="([^"]+)"/)
          ? { flow_id: text.match(/name="flow_id" value="([^"]+)"/)[1] }
          : {}),
      }),
    });
  }
}
export async function harness(t, { startApp = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ynab-integrated-"))),
    dir = join(root, "state"),
    keyFile = join(root, "keys.json");
  mkdirSync(dir, { mode: 0o700 });
  const appPort = await port(),
    mockPort = await port(),
    nativePort = await port(),
    webPort = await port(),
    origin = `http://127.0.0.1:${appPort}`,
    owner = "11111111-1111-4111-8111-111111111111";
  const pair = await generateKeyPair("RS256", { extractable: true });
  const signing = {
    ...(await exportJWK(pair.privateKey)),
    kid: "synthetic-one",
    use: "sig",
    alg: "RS256",
  };
  writeFileSync(
    keyFile,
    JSON.stringify({
      encryption: randomBytes(32).toString("hex"),
      lookup: randomBytes(32).toString("hex"),
      cookie: randomBytes(32).toString("hex"),
      signing: [signing],
    }),
    { mode: 0o600 },
  );
  const secret = () => `synthetic-${randomBytes(32).toString("hex")}`;
  const env = {
    LOCAL_FIXTURE_MODE: "true",
    DATA_MODE: "fixtures",
    AUTH_MODE: "integrated-mock",
    PORT: String(appPort),
    AUTH_ISSUER: origin,
    AUTH_AUDIENCE: `${origin}/mcp`,
    MCP_PUBLIC_URL: `${origin}/mcp`,
    AUTH_ALLOWED_SUBJECT: owner,
    MOCK_YNAB_ORIGIN: `http://127.0.0.1:${mockPort}/`,
    OAUTH_STATE_DIR: dir,
    OAUTH_KEY_FILE: keyFile,
    OAUTH_NATIVE_CALLBACK: `http://127.0.0.1:${nativePort}/callback`,
    OAUTH_WEB_CALLBACK: `http://127.0.0.1:${webPort}/callback`,
    OAUTH_WEB_SECRET: secret(),
    MOCK_YNAB_SECRET: secret(),
    FIXTURE_ALLOWED_PLAN_IDS: '["fixture-plan-sgd"]',
  };
  const mock = mockYnab({
    port: mockPort,
    callback: `${origin}/connect/ynab/callback`,
    secret: env.MOCK_YNAB_SECRET,
    owner,
  });
  await mock.start();
  let app;
  async function start() {
    app = createFixtureHttp(parseConfig(env));
    await new Promise((r, j) => {
      app.server.once("error", j);
      app.server.listen(appPort, "127.0.0.1", r);
    });
  }
  async function stop() {
    if (app) {
      await app.close();
      app = undefined;
    }
  }
  try {
    if (startApp) await start();
  } catch (e) {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const close = async () => {
    await stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  };
  t?.after(close);
  return { origin, env, mock, root, dir, keyFile, start, stop, close };
}
export async function authorize(
  h,
  {
    client = "synthetic-native",
    browser = new Browser(),
    decision = "continue",
  } = {},
) {
  const verifier = randomBytes(32).toString("base64url"),
    callback =
      client === "synthetic-native"
        ? h.env.OAUTH_NATIVE_CALLBACK
        : h.env.OAUTH_WEB_CALLBACK;
  const query = new URLSearchParams({
    client_id: client,
    redirect_uri: callback,
    response_type: "code",
    scope: "ynab:read",
    resource: `${h.origin}/mcp`,
    state: "downstream-state",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  let r = await browser.fetch(`${h.origin}/auth?${query}`);
  if (r.status !== 303) throw Error(`AUTH_${r.status}:${await r.text()}`);
  let location = new URL(r.headers.get("location"), h.origin).href;
  r = await browser.form(location, decision);
  for (let i = 0; i < 8 && r.headers.has("location"); i++) {
    location = new URL(r.headers.get("location"), location).href;
    if (location.startsWith(callback))
      return {
        params: new URL(location).searchParams,
        verifier,
        callback,
        browser,
      };
    if (location.startsWith(h.mock.origin + "/oauth/authorize"))
      r = await browser.form(location, "allow");
    else r = await browser.fetch(location);
  }
  throw Error(`FLOW_${r.status}:${await r.text()}`);
}
export async function exchange(h, a, extra = {}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "synthetic-native",
    redirect_uri: a.callback,
    code: a.params.get("code"),
    code_verifier: a.verifier,
    resource: `${h.origin}/mcp`,
    ...extra,
  });
  const r = await fetch(`${h.origin}/token`, { method: "POST", body });
  return { status: r.status, body: await r.json() };
}
