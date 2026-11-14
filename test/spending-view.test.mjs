import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  stat,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { compileAnalysis } from "../dist/tools/spending-analysis.js";
import {
  spendingValidator,
  spendingResource,
  spendingResourceUri,
} from "../dist/ui/resource.js";
import {
  capturedAnalysis,
  exportPreview,
} from "../scripts/export-spending-preview.mjs";
import { input, fixture, report } from "./helpers/analysis.mjs";
import { serve, connect } from "./helpers/server.mjs";
const sample = () => compileAnalysis(input, fixture());
const use = (id, name, args) => ({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id,
        name: `mcp__claude_ai_MCP_Tools_for_YNAB__${name}`,
        input: args,
      },
    ],
  },
});
const result = (id, data) => ({
  type: "user",
  timestamp: "2026-11-14T00:00:00Z",
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, content: JSON.stringify(data) },
    ],
  },
  tool_use_result: {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify(data) }],
  },
});
export function capture(data = sample(), args = input) {
  return [
    use("plans", "ynab_list_plans", {}),
    result("plans", {
      data_mode: "fixtures",
      truncated: false,
      plans: [
        { id: input.plan_id, name: "Invented plan", currency_code: "SGD" },
      ],
    }),
    use("analysis", "ynab_get_spending_analysis", args),
    result("analysis", data),
  ];
}
const lines = (events) => events.map((x) => JSON.stringify(x)).join("\n");
test("exact original charts and answer validate, including default comparison, negatives and hostile escaped labels", async () => {
  for (const values of [
    fixture(),
    [report("2026-08-01", 1000, 2000), report("2026-09-01", 800, 3000)],
  ]) {
    for (const r of values)
      r.categories[0].name = `<script>not code</script>&${"long label ".repeat(10)}`;
    const a = compileAnalysis(input, values);
    assert.equal(await spendingValidator.validate(a, input), a);
  }
  const single = { ...input, last_month: input.first_month };
  await spendingValidator.validate(
    compileAnalysis(single, [fixture()[0]]),
    single,
  );
});
for (const [name, mutate] of [
  [
    "altered chart",
    (r) => {
      r.charts[0].svg = r.charts[0].svg.replace("100.00", "999.00");
    },
  ],
  [
    "external SVG",
    (r) => {
      r.charts[0].svg = r.charts[0].svg.replace(
        "</svg>",
        '<image href="https://evil.invalid/a"/></svg>',
      );
    },
  ],
  [
    "active SVG",
    (r) => {
      r.charts[0].svg = r.charts[0].svg.replace(
        "<svg ",
        '<svg onload="alert(1)" ',
      );
    },
  ],
  [
    "changed canonical answer",
    (r) => {
      r.canonical_answer = "Invented numbers";
    },
  ],
  [
    "changed facts",
    (r) => {
      r.totals.net_spending_milliunits++;
    },
  ],
  [
    "truncated result",
    (r) => {
      r.truncated = true;
    },
  ],
  [
    "partial result",
    (r) => {
      r.complete = false;
    },
  ],
  [
    "unknown field",
    (r) => {
      r.another = "wrong";
    },
  ],
  [
    "unsafe integer",
    (r) => {
      r.months[0].net_spending_milliunits = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "missing month",
    (r) => {
      r.months.pop();
    },
  ],
  [
    "duplicate category",
    (r) => {
      r.categories.push(r.categories[0]);
    },
  ],
  [
    "oversize",
    (r) => {
      r.canonical_answer = "x".repeat(65536);
    },
  ],
  [
    "wrong source",
    (r) => {
      r.source = "ynab";
    },
  ],
  [
    "chart order",
    (r) => {
      r.charts.reverse();
    },
  ],
])
  test(`view rejects ${name} without substitute figures`, async () => {
    const r = sample();
    mutate(r);
    await assert.rejects(spendingValidator.validate(r, input));
  });
test("request identity, explicit comparison and provisional opt-in are enforced", async () => {
  for (const args of [
    { ...input, plan_id: "fixture-plan-other" },
    { ...input, last_month: "2026-10-01" },
    { ...input, comparison_month: "2026-08-01" },
    { ...input, extra: 1 },
  ])
    await assert.rejects(spendingValidator.validate(sample(), args));
  const r = sample();
  r.all_periods_closed = false;
  r.months[0].period_closed = false;
  await assert.rejects(spendingValidator.validate(r, input));
});
for (const era of ["legacy", "modern"])
  test(`authenticated ${era} UI discovery/read keeps seven tools and non-UI fallback`, async (t) => {
    const app = await serve(t),
      client = await connect(t, app.url, era);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    assert.equal(tools.filter((t) => t._meta?.ui?.resourceUri).length, 1);
    assert.equal(
      tools.find((t) => t.name === "ynab_get_spending_analysis")._meta.ui
        .resourceUri,
      spendingResourceUri,
    );
    const listing = await client.listResources();
    assert.equal(listing.resources[0].uri, spendingResourceUri);
    const r = await client.readResource({ uri: spendingResourceUri });
    assert.equal(r.contents[0].text, spendingResource.text);
    assert.equal(r.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(Buffer.byteLength(r.contents[0].text) < 65536);
    assert.deepEqual(r.contents[0]._meta.ui.csp, {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    assert.deepEqual(r.contents[0]._meta.ui.permissions, {});
    const anonymous = await fetch(app.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: spendingResourceUri },
      }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(
      (await fetch(new URL("/spending/analysis-v1.html", app.url))).status,
      404,
    );
  });
test("Code capture binds selected plan, request, tool-result identity and actual content; ignores assistant prose", async () => {
  const events = capture();
  events.push({
    type: "assistant",
    message: { content: [{ type: "text", text: "Made up chart totals" }] },
  });
  assert.deepEqual((await capturedAnalysis(lines(events))).report, sample());
  for (const mutate of [
    (e) => e.splice(0, 2),
    (e) => {
      e[2].message.content[0].input = {
        ...input,
        plan_id: "fixture-plan-other",
      };
    },
    (e) => {
      e[3].message.content[0].tool_use_id = "not-the-call";
    },
    (e) => {
      e[3].message.content[0].is_error = true;
    },
    (e) => {
      e[3].tool_use_result.isError = true;
    },
    (e) => {
      e[3].message.content[0].content = "{}";
    },
    (e) => {
      e.push(
        use("second", "ynab_get_spending_analysis", input),
        result("second", sample()),
      );
    },
  ]) {
    const e = capture();
    mutate(e);
    await assert.rejects(capturedAnalysis(lines(e)));
  }
  await assert.rejects(capturedAnalysis("x".repeat(16 * 1024 * 1024 + 1)));
});
test("export creates protected offline files and rejects existing output, symlinks and permissive input", async (t) => {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "ynab-ui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, "capture.jsonl"),
    out = join(dir, "preview");
  await writeFile(src, lines(capture()), { mode: 0o600 });
  await exportPreview(src, out);
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  for (const f of ["index.html", "analysis.json"])
    assert.equal((await stat(join(out, f))).mode & 0o777, 0o600);
  const html = await readFile(join(out, "index.html"), "utf8");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /Private Claude Code preview/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/);
  await assert.rejects(exportPreview(src, out));
  await symlink(src, join(dir, "alias"));
  await assert.rejects(exportPreview(join(dir, "alias"), join(dir, "other")));
  await chmod(src, 0o644);
  await assert.rejects(exportPreview(src, join(dir, "other")));
});
