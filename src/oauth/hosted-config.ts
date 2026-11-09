import { ConfigError } from "../errors.js";

export type HostedConfig = Readonly<{
  mode: "integrated-hosted";
  origin: string;
  dir: "/data/authorization";
  runtimeDir: "/run/ynab-mcp";
  port: number;
  keyBundle: string;
  nativeId: string;
  nativeCallback: string;
  webId: string;
  webCallback: string;
  webMethod: "client_secret_post" | "client_secret_basic";
  webSecret: string;
  ynabId: string;
  ynabSecret: string;
  enrollment:
    | { kind: "owner"; owner: string }
    | { kind: "enroll"; capability: string; expires: number; issuance: string };
}>;
export function hostedConfig(
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): HostedConfig {
  const get = (k: string) => {
    const v = env[k];
    if (!v || v.trim() !== v || v.length > 32768) throw new ConfigError(k);
    return v;
  };
  if (
    env.AUTH_MODE !== "integrated-hosted" ||
    env.HOSTED_AUTHORIZATION_ENABLED !== "true"
  )
    throw new ConfigError("AUTH_MODE");
  if (
    env.NODE_ENV !== "production" ||
    env.DATA_MODE !== "fixtures" ||
    env.LOCAL_FIXTURE_MODE !== undefined
  )
    throw new ConfigError("NODE_ENV");
  for (const k of [
    "DEBUG",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "NODE_V8_COVERAGE",
    "NODE_COMPILE_CACHE",
    "NODE_REDIRECT_WARNINGS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_USE_ENV_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "YNAB_ACCESS_TOKEN",
    "YNAB_TOKEN",
    "MOCK_YNAB_ORIGIN",
    "MOCK_YNAB_SECRET",
    "OAUTH_KEY_FILE",
    "AUTH_FIXTURE_FILE",
    "AUTH0_DOMAIN",
  ])
    if (env[k] !== undefined) throw new ConfigError(k);
  if (env.HOST !== undefined && env.HOST !== "0.0.0.0")
    throw new ConfigError("HOST");
  const port = get("PORT");
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
    throw new ConfigError("PORT");
  const origin = get("AUTH_ISSUER");
  if (
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.up\.railway\.app$/.test(
      origin,
    )
  )
    throw new ConfigError("AUTH_ISSUER");
  if (
    get("AUTH_AUDIENCE") !== `${origin}/mcp` ||
    get("MCP_PUBLIC_URL") !== `${origin}/mcp`
  )
    throw new ConfigError("AUTH_AUDIENCE");
  if (get("OAUTH_STATE_DIR") !== "/data/authorization")
    throw new ConfigError("OAUTH_STATE_DIR");
  const id = (k: string) => {
    const v = get(k);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(v) || v.startsWith("synthetic-"))
      throw new ConfigError(k);
    return v;
  };
  const secret = (k: string) => {
    const v = get(k);
    if (
      v.length < 32 ||
      v.length > 4096 ||
      !/^[\x21-\x7e]+$/.test(v) ||
      v.startsWith("synthetic-")
    )
      throw new ConfigError(k);
    return v;
  };
  const callback = (k: string, native: boolean) => {
    const v = get(k);
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new ConfigError(k);
    }
    if (
      u.href !== v ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !/^\/[A-Za-z0-9/_-]+$/.test(u.pathname) ||
      (native
        ? u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port
        : u.protocol !== "https:" || u.port !== "")
    )
      throw new ConfigError(k);
    return v;
  };
  const webMethod = get("OAUTH_WEB_AUTH_METHOD");
  if (webMethod !== "client_secret_post" && webMethod !== "client_secret_basic")
    throw new ConfigError("OAUTH_WEB_AUTH_METHOD");
  const nativeId = id("OAUTH_NATIVE_CLIENT_ID"),
    webId = id("OAUTH_WEB_CLIENT_ID");
  if (nativeId === webId) throw new ConfigError("OAUTH_WEB_CLIENT_ID");
  let enrollment: HostedConfig["enrollment"];
  if (env.AUTH_ALLOWED_SUBJECT) {
    const owner = get("AUTH_ALLOWED_SUBJECT");
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner))
      throw new ConfigError("AUTH_ALLOWED_SUBJECT");
    for (const k of [
      "OAUTH_ENROLLMENT_CAPABILITY",
      "OAUTH_ENROLLMENT_EXPIRES",
      "OAUTH_ENROLLMENT_ID",
    ])
      if (env[k] !== undefined) throw new ConfigError(k);
    enrollment = { kind: "owner", owner };
  } else {
    const capability = get("OAUTH_ENROLLMENT_CAPABILITY"),
      expires = Number(get("OAUTH_ENROLLMENT_EXPIRES")),
      issuance = id("OAUTH_ENROLLMENT_ID");
    if (
      !/^[a-f0-9]{64}$/.test(capability) ||
      !Number.isSafeInteger(expires) ||
      expires <= 0 ||
      expires > now + 900000
    )
      throw new ConfigError("OAUTH_ENROLLMENT_CAPABILITY");
    enrollment = { kind: "enroll", capability, expires, issuance };
  }
  return Object.freeze({
    mode: "integrated-hosted",
    origin,
    dir: "/data/authorization",
    runtimeDir: "/run/ynab-mcp",
    port: Number(port),
    keyBundle: get("OAUTH_KEY_BUNDLE"),
    nativeId,
    webId,
    nativeCallback: callback("OAUTH_NATIVE_CALLBACK", true),
    webCallback: callback("OAUTH_WEB_CALLBACK", false),
    webMethod,
    webSecret: secret("OAUTH_WEB_SECRET"),
    ynabId: id("YNAB_CLIENT_ID"),
    ynabSecret: secret("YNAB_CLIENT_SECRET"),
    enrollment,
  });
}
