import { ConfigError } from "../errors.js";

export const ISSUER = "https://issuer.example.test/";
export const DISCOVERY = `${ISSUER}.well-known/openid-configuration`;
export const JWKS = `${ISSUER}.well-known/jwks.json`;
export type AuthConfig = Readonly<{
  issuer: string;
  audience: string;
  subject: string;
  fixtureFile: string;
}>;
export function authConfig(env: NodeJS.ProcessEnv, port: number): AuthConfig {
  const required = (key: string) => {
    const value = env[key];
    if (!value || value.trim() !== value) throw new ConfigError(key);
    return value;
  };
  const issuer = required("AUTH_ISSUER");
  if (issuer !== ISSUER) throw new ConfigError("AUTH_ISSUER");
  const audience = required("AUTH_AUDIENCE");
  if (audience !== `http://127.0.0.1:${port}/mcp`)
    throw new ConfigError("AUTH_AUDIENCE");
  if (required("MCP_PUBLIC_URL") !== audience)
    throw new ConfigError("MCP_PUBLIC_URL");
  const subject = required("AUTH_ALLOWED_SUBJECT");
  if (!/^[\x20-\x7e]{1,128}$/.test(subject))
    throw new ConfigError("AUTH_ALLOWED_SUBJECT");
  return Object.freeze({
    issuer,
    audience,
    subject,
    fixtureFile: required("AUTH_FIXTURE_FILE"),
  });
}
