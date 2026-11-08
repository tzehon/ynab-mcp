import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

export const issuer = "https://issuer.example.test/";
export const owner = "synthetic-owner";
export const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
export const jwk = {
  ...(await exportJWK(pair.publicKey)),
  alg: "RS256",
  use: "sig",
  kid: "synthetic-key",
};
export const bundle = {
  discovery: {
    issuer,
    jwks_uri: `${issuer}.well-known/jwks.json`,
    authorization_endpoint: `${issuer}authorize`,
    token_endpoint: `${issuer}oauth/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  },
  jwks: { keys: [jwk] },
};
const directory = mkdtempSync(join(tmpdir(), "ynab-auth-public-"));
export const fixtureFile = join(directory, "public.json");
writeFileSync(fixtureFile, JSON.stringify(bundle), { mode: 0o600 });
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
export const fixtureEnv = {
  LOCAL_FIXTURE_MODE: "true",
  DATA_MODE: "fixtures",
  NODE_ENV: "test",
  FIXTURE_ALLOWED_PLAN_IDS: '["fixture-plan-sgd"]',
  AUTH_ISSUER: issuer,
  AUTH_ALLOWED_SUBJECT: owner,
  AUTH_FIXTURE_FILE: fixtureFile,
  AUTH_AUDIENCE: "http://127.0.0.1:3000/mcp",
  MCP_PUBLIC_URL: "http://127.0.0.1:3000/mcp",
};
export function portEnv(port) {
  const url = `http://127.0.0.1:${port}/mcp`;
  return { PORT: String(port), AUTH_AUDIENCE: url, MCP_PUBLIC_URL: url };
}
export async function sign(
  audience,
  claims = {},
  header = {},
  key = pair.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    sub: owner,
    aud: audience,
    iat: now,
    exp: now + 120,
    client_id: "synthetic-client",
    jti: "synthetic-id",
    scope: "ynab:read",
    ...claims,
  })
    .setProtectedHeader({
      alg: "RS256",
      typ: "at+jwt",
      kid: jwk.kid,
      ...header,
    })
    .sign(key);
}
const tokens = new Map();
export function tokenFor(port) {
  return tokens.get(Number(port));
}
export async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  tokens.set(port, await sign(`http://127.0.0.1:${port}/mcp`));
  return port;
}
export async function authorizedFetch(input, options = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers = new Headers(options.headers);
  if (!headers.has("authorization") && tokens.has(Number(url.port)))
    headers.set("Authorization", `Bearer ${tokenFor(url.port)}`);
  return fetch(input, { ...options, headers });
}
