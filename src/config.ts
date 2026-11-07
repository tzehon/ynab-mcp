import {
  fixtureMap,
  validateFixtureMap,
  type FixtureMap,
} from "./fixtures/ynab.js";
import { ConfigError } from "./errors.js";
import { fixturePlans, validateCatalog, type Plan } from "./fixtures/plans.js";

export type Config = Readonly<{
  host: "127.0.0.1";
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
  const portText = env.PORT ?? "3000";
  if (
    !/^[0-9]+$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new ConfigError("PORT");
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
    host: "127.0.0.1",
    port: Number(portText),
    allowedIds: Object.freeze([...allowed] as string[]),
    catalog: plans,
    fixtureMap: validateFixtureMap(plans, map),
  });
}
