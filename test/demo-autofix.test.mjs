import test from "node:test";
import assert from "node:assert/strict";
import { demoFiles, parseArgs, runDemo } from "../scripts/demo-autofix.mjs";
import { metadata, body } from "./helpers.mjs";

function fixture(change = {}) {
  const calls = [],
    logs = [];
  const m = metadata();
  m.issueUrl = "https://example.atlassian.net/browse/YNAB-17";
  for (const a of Object.values(m.approvals)) {
    a.snapshotUrl = "https://example.atlassian.net/attachment/123";
    a.decisionUrl = `${m.issueUrl}?focusedCommentId=456`;
  }
  const repo = { full_name: "tzehon/ynab-mcp" };
  const approval = {
    title: "YNAB-17: Archive and repeat demos",
    merged: true,
    user: { login: "tzehon" },
    base: { ref: "main", repo },
    head: { repo },
    body: `<!-- autofix-demo-approval:v1 -->\n${body(m)}`,
  };
  const values = {
    user: { login: "tzehon" },
    approval,
    enabled: { value: "true" },
    model: { value: "test-model" },
    ref: { object: { sha: "a".repeat(40) } },
    commit: { tree: { sha: "b".repeat(40) } },
    tree: {
      truncated: false,
      tree: [
        { path: "src", type: "tree" },
        { path: "test", type: "tree" },
      ],
    },
    ...change,
  };
  const api = async (path, method = "GET", data) => {
    calls.push({ path, method, data });
    if (method === "POST") {
      if (path.endsWith(change.failAt ?? "no-failure"))
        throw new Error("provider message must not leak");
      if (path.endsWith("/pulls"))
        return { number: 999, html_url: "https://evil.invalid" };
      return { sha: "c".repeat(40) };
    }
    if (path === "user") return values.user;
    if (path.endsWith("/pulls/29")) return values.approval;
    if (path.endsWith("CODEX_AUTOFIX_ENABLED")) return values.enabled;
    if (path.endsWith("CODEX_AUTOFIX_MODEL")) return values.model;
    if (path.endsWith("/git/ref/heads/main")) return values.ref;
    if (path.includes("/git/commits/")) return values.commit;
    if (path.includes("/git/trees/")) return values.tree;
    throw new Error(`Unexpected request ${path}`);
  };
  return {
    calls,
    logs,
    values,
    api,
    log: (s) => logs.push(s),
    nonce: () => "a".repeat(24),
  };
}

test("demo CLI defaults to preview and rejects ambiguous or malformed input", () => {
  assert.deepEqual(parseArgs(["--approval-pr", "29"]), {
    approvalPr: 29,
    publish: false,
  });
  assert.deepEqual(parseArgs(["--publish", "--approval-pr", "29"]), {
    approvalPr: 29,
    publish: true,
  });
  for (const args of [
    [],
    ["--approval-pr"],
    ["--approval-pr", "-1"],
    ["--approval-pr", "1;rm"],
    ["--approval-pr", "9007199254740992"],
    ["--approval-pr", "29", "--force"],
    ["--approval-pr", "29", "--publish", "--publish"],
    ["--approval-pr", "29", "--approval-pr", "30"],
  ])
    assert.throws(() => parseArgs(args));
});

test("preview uses read-only requests and preserves all four assertions", async () => {
  const f = fixture();
  const r = await runDemo({ approvalPr: 29, publish: false }, f);
  assert.equal(r.published, false);
  assert.ok(f.calls.every((c) => c.method === "GET"));
  assert.match(demoFiles["src/autofix-showcase.ts"], /return left - right/);
  assert.equal(
    (demoFiles["test/autofix-showcase.test.mjs"].match(/assert.equal/g) ?? [])
      .length,
    4,
  );
});

test("publish writes only fixed files on a fresh branch and pending linked PR", async () => {
  const f = fixture();
  const r = await runDemo({ approvalPr: 29, publish: true }, f);
  assert.equal(r.url, "https://github.com/tzehon/ynab-mcp/pull/999");
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.deepEqual(
    writes.map((c) => c.path.split("/").slice(3).join("/")),
    ["git/trees", "git/commits", "git/refs", "pulls"],
  );
  assert.deepEqual(
    writes[0].data.tree.map((e) => e.path),
    Object.keys(demoFiles),
  );
  assert.ok(
    writes[0].data.tree.every((e) => e.mode === "100644" && e.type === "blob"),
  );
  assert.equal(writes[0].data.base_tree, "b".repeat(40));
  assert.deepEqual(writes[1].data.parents, ["a".repeat(40)]);
  assert.equal(writes[2].data.ref, `refs/heads/${r.branch}`);
  assert.equal(writes[3].data.head, r.branch);
  assert.equal(writes[3].data.base, "main");
  const m = JSON.parse(
    /```ynab-metadata\n([\s\S]*?)\n```/.exec(writes[3].data.body)[1],
  );
  assert.ok(m.acceptanceCriteria.every((e) => e.status === "pending"));
  assert.match(writes[3].data.body, /Never merge/);
});

test("each invocation has a new branch and commit identity", async () => {
  const a = fixture(),
    b = fixture();
  b.nonce = () => "b".repeat(24);
  const x = await runDemo({ approvalPr: 29, publish: true }, a),
    y = await runDemo({ approvalPr: 29, publish: true }, b);
  assert.notEqual(x.branch, y.branch);
  assert.notEqual(
    a.calls.find((c) => c.path.endsWith("/git/commits")).data.message,
    b.calls.find((c) => c.path.endsWith("/git/commits")).data.message,
  );
});

test("owner, approval, metadata and activation failures occur before writes", async () => {
  for (const change of [
    { user: { login: "other" } },
    { enabled: { value: "false" } },
    { model: { value: "" } },
    { ref: { object: { sha: "bad" } } },
  ]) {
    const f = fixture(change);
    await assert.rejects(runDemo({ approvalPr: 29, publish: true }, f));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
  for (const mutate of [
    (a) => {
      a.merged = false;
    },
    (a) => {
      a.user.login = "bot";
    },
    (a) => {
      a.base.ref = "feature";
    },
    (a) => {
      a.head.repo = { full_name: "attacker/fork" };
    },
    (a) => {
      a.body = a.body.replace("autofix-demo-approval:v1", "missing");
    },
    (a) => {
      a.body = a.body.replace("AC-1", "AC-99");
    },
    (a) => {
      a.title = "YNAB-16: Wrong issue";
    },
  ]) {
    const f = fixture();
    mutate(f.values.approval);
    await assert.rejects(runDemo({ approvalPr: 29, publish: true }, f));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});

test("occupied or incomplete source trees cannot be overwritten", async () => {
  for (const tree of [
    { truncated: true, tree: [] },
    { truncated: false, tree: [] },
    {
      truncated: false,
      tree: [{ path: "src/autofix-showcase.ts", type: "blob" }],
    },
  ]) {
    const f = fixture({ tree });
    await assert.rejects(runDemo({ approvalPr: 29, publish: true }, f));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});

test("partial publication failures identify recovery branch without retry or cleanup", async () => {
  for (const failAt of ["/git/trees", "/git/commits", "/git/refs", "/pulls"]) {
    const f = fixture({ failAt });
    await assert.rejects(
      runDemo({ approvalPr: 29, publish: true }, f),
      (error) =>
        /Inspect branch YNAB-17-showcase-/.test(error.message) &&
        !error.message.includes("provider message"),
    );
    assert.ok(f.calls.every((c) => ["GET", "POST"].includes(c.method)));
    assert.equal(
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith(failAt))
        .length,
      1,
    );
  }
});
