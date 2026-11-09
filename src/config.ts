import { type AuthConfig, authConfig } from "./auth/config.js";
import { hostedConfig, type HostedConfig } from "./oauth/hosted-config.js";
import { ConfigError } from "./errors.js";
import { fixturePlans, type Plan, validateCatalog } from "./fixtures/plans.js";
import {
  type FixtureMap,
  fixtureMap,
  validateFixtureMap,
} from "./fixtures/ynab.js";
import { type OAuthConfig, oauthConfig } from "./oauth/config.js";

export type Config = Readonly<{
  auth: AuthConfig;
  oauth?: OAuthConfig;
  hosted?: HostedConfig;
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  allowedIds: readonly string[];
  catalog: readonly Plan[];
  fixtureMap: FixtureMap;
}>;
export function parseConfig(
  env: NodeJS.ProcessEnv,
  catalog: unknown = fixturePlans,
  map: unknown = fixtureMap,
): Config {
  const hosted =
    env.AUTH_MODE === "integrated-hosted" ? hostedConfig(env) : undefined;
  if (!hosted) {
    if (env.LOCAL_FIXTURE_MODE !== "true")
      throw new ConfigError("LOCAL_FIXTURE_MODE");
    if (env.DATA_MODE !== "fixtures") throw new ConfigError("DATA_MODE");
    if (
      env.NODE_ENV !== undefined &&
      !["development", "test"].includes(env.NODE_ENV)
    )
      throw new ConfigError("NODE_ENV");
    if (env.HOST !== undefined && env.HOST !== "127.0.0.1")
      throw new ConfigError("HOST");
    if (env.YNAB_ACCESS_TOKEN) throw new ConfigError("YNAB_ACCESS_TOKEN");
  }
  const portText = env.PORT ?? "3000";
  if (
    !/^[0-9]+$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new ConfigError("PORT");
  if (
    env.AUTH_MODE &&
    !["fixture-token", "integrated-mock", "integrated-hosted"].includes(
      env.AUTH_MODE,
    )
  )
    throw new ConfigError("AUTH_MODE");
  const oauth =
    env.AUTH_MODE === "integrated-mock"
      ? oauthConfig(env, Number(portText))
      : undefined;
  const plans = validateCatalog(catalog);
  let allowed: unknown;
  try {
    allowed =
      env.FIXTURE_ALLOWED_PLAN_IDS === undefined
        ? []
        : JSON.parse(env.FIXTURE_ALLOWED_PLAN_IDS);
  } catch {
    throw new ConfigError("FIXTURE_ALLOWED_PLAN_IDS");
  }
  if (
    !Array.isArray(allowed) ||
    allowed.some(
      (id) => typeof id !== "string" || !plans.some((p) => p.id === id),
    ) ||
    new Set(allowed).size !== allowed.length
  )
    throw new ConfigError("FIXTURE_ALLOWED_PLAN_IDS");
  return Object.freeze({
    auth: hosted
      ? {
          issuer: hosted.origin,
          audience: `${hosted.origin}/mcp`,
          subject:
            hosted.enrollment.kind === "owner" ? hosted.enrollment.owner : "",
          fixtureFile: "",
        }
      : oauth
        ? {
            issuer: oauth.origin,
            audience: `${oauth.origin}/mcp`,
            subject: oauth.owner,
            fixtureFile: "",
          }
        : authConfig(env, Number(portText)),
    oauth,
    hosted,
    host: hosted ? "0.0.0.0" : "127.0.0.1",
    port: Number(portText),
    allowedIds: Object.freeze([...allowed] as string[]),
    catalog: plans,
    fixtureMap: validateFixtureMap(plans, map),
  });
}
