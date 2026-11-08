import { portEnv } from "./helpers/auth.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../dist/config.js";
import { fixturePlans, validateCatalog } from "../dist/fixtures/plans.js";
import { fixtureEnv } from "./helpers/server.mjs";

test("config allows only explicit local fixtures and never echoes supplied values", () => {
  const c = parseConfig(fixtureEnv);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 3000);
  for (const [key, values] of Object.entries({
    LOCAL_FIXTURE_MODE: [undefined, "", "false"],
    DATA_MODE: [undefined, "live", ""],
    NODE_ENV: ["production", "", "SECRET_MARKER"],
    HOST: ["0.0.0.0", "::", "localhost", "192.0.2.1", ""],
    PORT: ["0", "-1", "1.5", "1e3", "65536", "no", ""],
    YNAB_ACCESS_TOKEN: ["SECRET_MARKER"],
  }))
    for (const value of values) {
      assert.throws(
        () => parseConfig({ ...fixtureEnv, [key]: value }),
        (error) =>
          error.message === `CONFIG_${key}` &&
          !error.message.includes("SECRET_MARKER"),
        `${key}=${value}`,
      );
    }
  for (const NODE_ENV of [undefined, "development", "test"])
    assert.equal(parseConfig({ ...fixtureEnv, NODE_ENV }).port, 3000);
  for (const PORT of ["1", "65535"])
    assert.equal(parseConfig({ ...fixtureEnv, ...portEnv(PORT) }).port, Number(PORT));
  assert.throws(() =>
    parseConfig({
      ...fixtureEnv,
      NODE_ENV: "production",
      OAUTH_ISSUER: "fake",
    }),
  );
});
test("allowlist is exact, bounded, unique and deny-all by default", () => {
  for (const value of [undefined, "[]"])
    assert.deepEqual(
      parseConfig({ ...fixtureEnv, FIXTURE_ALLOWED_PLAN_IDS: value })
        .allowedIds,
      [],
    );
  for (const value of [
    "",
    "invalid",
    "null",
    "{}",
    "1",
    '["fixture-plan-sgd","fixture-plan-sgd"]',
    '["fixture-plan-unknown"]',
    "[1]",
    '["fixture-plan-sgd.extra"]',
  ])
    assert.throws(
      () => parseConfig({ ...fixtureEnv, FIXTURE_ALLOWED_PLAN_IDS: value }),
      /CONFIG_FIXTURE_ALLOWED_PLAN_IDS/,
    );
  assert.ok(Object.isFrozen(parseConfig(fixtureEnv).allowedIds));
});
test("catalog validation rejects duplicates, invalid shapes and more than ten rows", () => {
  assert.equal(validateCatalog(fixturePlans).length, 2);
  assert.deepEqual(validateCatalog([]), []);
  for (const value of [
    [...fixturePlans, fixturePlans[0]],
    Array.from({ length: 11 }, (_, i) => ({
      id: `fixture-plan-${i}`,
      name: "Synthetic",
      currency_code: "SGD",
    })),
    [{ ...fixturePlans[0], id: "real-id" }],
    [{ ...fixturePlans[0], currency_code: "sgd" }],
    [{ ...fixturePlans[0], name: "" }],
    [{ ...fixturePlans[0], name: "x".repeat(81) }],
    [{ ...fixturePlans[0], private: "unexpected" }],
    null,
  ])
    assert.throws(() => validateCatalog(value), /CONFIG_CATALOG/);
});
