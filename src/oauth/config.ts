import { ConfigError } from "../errors.js";
export type OAuthConfig = {
  origin: string;
  upstream: string;
  owner: string;
  dir: string;
  keyFile: string;
  nativeCallback: string;
  webCallback: string;
  webSecret: string;
  upstreamSecret: string;
};
export function oauthConfig(env: NodeJS.ProcessEnv, port: number): OAuthConfig {
  const get = (k: string) => {
    const v = env[k];
    if (!v || v.trim() !== v) throw new ConfigError(k);
    return v;
  };
  if (env.DEBUG) throw new ConfigError("DEBUG");
  const origin = `http://127.0.0.1:${port}`;
  const local = (k: string, path: string) => {
    const v = get(k);
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new ConfigError(k);
    }
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      !u.port ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      u.pathname !== path ||
      u.href !== v
    )
      throw new ConfigError(k);
    return v;
  };
  const upstream = local("MOCK_YNAB_ORIGIN", "/").replace(/\/$/, "");
  if (upstream === origin) throw new ConfigError("MOCK_YNAB_ORIGIN");
  const owner = get("AUTH_ALLOWED_SUBJECT");
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner))
    throw new ConfigError("AUTH_ALLOWED_SUBJECT");
  for (const k of [
    "YNAB_CLIENT_ID",
    "YNAB_CLIENT_SECRET",
    "YNAB_TOKEN",
    "AUTH0_DOMAIN",
  ])
    if (env[k]) throw new ConfigError(k);
  const secret = (k: string) => {
    const s = get(k);
    if (!/^synthetic-[a-f0-9]{64}$/.test(s)) throw new ConfigError(k);
    return s;
  };
  if (
    get("AUTH_ISSUER") !== origin ||
    get("AUTH_AUDIENCE") !== `${origin}/mcp` ||
    get("MCP_PUBLIC_URL") !== `${origin}/mcp`
  )
    throw new ConfigError("AUTH_ISSUER");
  return {
    origin,
    upstream,
    owner,
    dir: get("OAUTH_STATE_DIR"),
    keyFile: get("OAUTH_KEY_FILE"),
    nativeCallback: local("OAUTH_NATIVE_CALLBACK", "/callback"),
    webCallback: local("OAUTH_WEB_CALLBACK", "/callback"),
    webSecret: secret("OAUTH_WEB_SECRET"),
    upstreamSecret: secret("MOCK_YNAB_SECRET"),
  };
}
