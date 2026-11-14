import test from "node:test";
import assert from "node:assert/strict";
import { serve, connect } from "./helpers/server.mjs";
import { outputSchema } from "../dist/tools/list-plans.js";
import { listPlans } from "../dist/tools/list-plans.js";
import { parseConfig } from "../dist/config.js";
import { fixtureEnv } from "./helpers/server.mjs";
for (const era of ["legacy", "modern"])
  test(`real HTTP ${era} handshake, schemas, read-only call and rejection`, async (t) => {
    const app = await serve(t);
    const wire = [];
    const c = await connect(t, app.url, era, (body, r, type) => {
      wire.push(body);
      if (r.status === 200) assert.match(type, /application\/json/);
    });
    assert.equal(c.getProtocolEra(), era);
    if (era === "legacy") {
      assert.ok(
        wire.some(
          (m) =>
            m.method === "initialize" &&
            m.params.protocolVersion === "2025-11-25",
        ),
      );
      assert.ok(wire.some((m) => m.method === "notifications/initialized"));
    } else assert.ok(wire.some((m) => m.method === "server/discover"));
    const { tools } = await c.listTools();
    assert.equal(tools.length, 7);
    assert.equal(tools[0].name, "ynab_list_plans");
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.ok(tools[0].outputSchema);
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
    }
    for (const [name, extra] of [
      ["ynab_list_accounts", {}],
      ["ynab_get_month", { month: "2026-11-01" }],
      ["ynab_get_spending_report", { month: "2026-11-01" }],
      [
        "ynab_get_spending_analysis",
        {
          first_month: "2026-11-01",
          last_month: "2026-11-01",
          include_open_month: true,
        },
      ],
      ["ynab_list_categories", {}],
      [
        "ynab_list_transactions",
        { since_date: "2026-11-01", until_date: "2026-11-07" },
      ],
    ]) {
      const result = await c.callTool({
        name,
        arguments: { plan_id: "fixture-plan-sgd", ...extra },
      });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(result.structuredContent.source, "mock-ynab");
      assert.deepEqual(
        JSON.parse(result.content[0].text),
        result.structuredContent,
      );
      const denied = await c.callTool({
        name,
        arguments: { plan_id: "fixture-plan-usd", ...extra },
      });
      assert.equal(denied.isError, true);
      assert.deepEqual(JSON.parse(denied.content[0].text), {
        error: { code: "PLAN_NOT_ALLOWED", message: "Plan is not allowed." },
      });
      assert.equal(denied.structuredContent, undefined);
    }
    for (const args of [{}, undefined]) {
      const result = await c.callTool({
        name: "ynab_list_plans",
        ...(args === undefined ? {} : { arguments: args }),
      });
      const data = outputSchema.parse(result.structuredContent);
      assert.deepEqual(data, listPlans(parseConfig(fixtureEnv)));
      assert.deepEqual(JSON.parse(result.content[0].text), data);
      assert.deepEqual(
        data.plans.map((p) => p.id),
        ["fixture-plan-sgd"],
      );
      assert.equal(data.truncated, false);
    }
    for (const args of [
      { SECRET_MARKER: "SECRET_MARKER" },
      { url: "https://example.invalid/SECRET_MARKER" },
    ]) {
      const bad = await c.callTool({
        name: "ynab_list_plans",
        arguments: args,
      });
      assert.equal(bad.isError, true);
      assert.ok(!JSON.stringify(bad).includes("SECRET_MARKER"));
      assert.equal(bad.structuredContent, undefined);
    }
    await assert.rejects(
      c.callTool({ name: "unknown_SECRET_MARKER", arguments: {} }),
      (error) => !error.message.includes("SECRET_MARKER"),
    );
    assert.ok(
      (await c.callTool({ name: "ynab_list_plans", arguments: {} }))
        .structuredContent,
    );
  });
test("real client sees deny-all empty output and unchanged repeated results", async (t) => {
  const app = await serve(t, { FIXTURE_ALLOWED_PLAN_IDS: "[]" }),
    c = await connect(t, app.url);
  const a = await c.callTool({ name: "ynab_list_plans", arguments: {} }),
    b = await c.callTool({ name: "ynab_list_plans", arguments: {} });
  assert.deepEqual(a, b);
  assert.deepEqual(a.structuredContent, {
    data_mode: "fixtures",
    plans: [],
    truncated: false,
  });
});
