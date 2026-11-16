import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  eligible,
  repairMetadata,
  validatePatch,
  applyPatch,
} from "../scripts/ci-autofix.mjs";

const sha = "a".repeat(40);
function input() {
  const repo = { full_name: "tzehon/ynab-mcp" };
  return {
    run: {
      name: "PR checks",
      path: ".github/workflows/pr-checks.yml",
      event: "pull_request",
      conclusion: "failure",
      run_attempt: 1,
      actor: { login: "tzehon" },
      triggering_actor: { login: "tzehon" },
      head_repository: repo,
      head_sha: sha,
      head_branch: "YNAB-99-fixture",
    },
    pr: {
      number: 99,
      state: "open",
      merged: false,
      user: { login: "tzehon" },
      base: { repo, ref: "main" },
      head: { repo, sha, ref: "YNAB-99-fixture" },
      title: "YNAB-99: Fixture change",
    },
    jobs: [
      { name: "bootstrap-tests", conclusion: "failure" },
      { name: "pr-metadata", conclusion: "success" },
    ],
  };
}
test("autofix admits only a current owner PR with failing application checks and valid metadata", () => {
  const { run, pr, jobs } = input();
  assert.equal(eligible(run, pr, jobs), true);
  for (const [field, value] of [
    ["name", "Other"],
    ["event", "push"],
    ["conclusion", "success"],
    ["run_attempt", 2],
    ["head_sha", "bad"],
    ["path", ".github/workflows/other.yml"],
    ["actor", { login: "outsider" }],
    ["triggering_actor", { login: "outsider" }],
    ["head_repository", { full_name: "fork/repo" }],
  ]) {
    assert.equal(eligible({ ...run, [field]: value }, pr, jobs), false, field);
  }
  for (const changed of [
    { ...pr, state: "closed" },
    { ...pr, merged: true },
    { ...pr, user: { login: "outsider" } },
    { ...pr, title: "YNAB-98: Wrong issue" },
    { ...pr, head: { ...pr.head, sha: "b".repeat(40) } },
    { ...pr, head: { ...pr.head, repo: { full_name: "fork/repo" } } },
    { ...pr, base: { ...pr.base, ref: "other" } },
    { ...pr, head: { ...pr.head, ref: "YNAB-99-autofix-fixture" } },
  ])
    assert.equal(eligible(run, changed, jobs), false);
  assert.equal(
    eligible(run, pr, [
      { name: "bootstrap-tests", conclusion: "success" },
      { name: "pr-metadata", conclusion: "failure" },
    ]),
    false,
  );
  assert.equal(
    eligible(run, pr, [{ name: "bootstrap-tests", conclusion: "failure" }]),
    false,
  );
});
function metadata() {
  const approval = {
    revision: "r1",
    snapshotUrl: "https://fixture.atlassian.net/secure/attachment/1/spec.json",
    decisionUrl:
      "https://fixture.atlassian.net/browse/YNAB-99?focusedCommentId=1",
  };
  return {
    schemaVersion: 1,
    issueUrl: "https://fixture.atlassian.net/browse/YNAB-99",
    approvals: { spec: approval, ac: approval, plan: approval },
    acceptanceCriteria: Array.from({ length: 8 }, (_, i) => ({
      id: `AC-${i + 1}`,
      check: "Original requirement",
      status: "passed",
      evidence: "Prior evidence",
    })),
  };
}
const body = (m) => `\`\`\`ynab-metadata\n${JSON.stringify(m)}\n\`\`\``;
test("repair preserves actual approval references but resets every acceptance claim", () => {
  const m = metadata(),
    r = repairMetadata(body(m), "YNAB-99");
  assert.deepEqual(r.approvals, m.approvals);
  assert.equal(r.issueUrl, m.issueUrl);
  assert.ok(
    r.acceptanceCriteria.every((a) => a.status === "pending" && a.remaining),
  );
  assert.throws(() => repairMetadata(body(m), "YNAB-98"));
  assert.throws(() => repairMetadata(body(m) + "\n" + body(m), "YNAB-99"));
  m.approvals.spec = {
    ...m.approvals.spec,
    decisionUrl: "https://evil.example/browse/YNAB-99?focusedCommentId=1",
  };
  assert.throws(() => repairMetadata(body(m), "YNAB-99"));
});
const patch = (path) =>
  `diff --git a/${path} b/${path}\nindex 1234567..abcdef0 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
test("patch parser admits bounded source/tests and rejects privileged paths and special git objects", () => {
  assert.deepEqual(validatePatch(patch("src/example.ts")), ["src/example.ts"]);
  assert.deepEqual(validatePatch(patch("test/example.test.mjs")), [
    "test/example.test.mjs",
  ]);
  for (const path of [
    ".github/workflows/x.yml",
    "AGENTS.md",
    "package.json",
    "package-lock.json",
    "scripts/ci-autofix.mjs",
    ".codex/config.toml",
    "src/../escape.ts",
    "src/../../escape.ts",
    "test/x.json",
    "src/example.ts/file.ts",
  ]) {
    assert.throws(() => validatePatch(patch(path)), path);
  }
  for (const bad of [
    patch("src/example.ts").replace("100644", "120000"),
    patch("src/example.ts").replace("100644", "160000"),
    patch("src/example.ts").replace("+++ b/src/example.ts", "+++ /dev/null"),
    patch("src/example.ts").replace(
      "index ",
      "old mode 100644\nnew mode 100755\nindex ",
    ),
    patch("src/example.ts") + patch("src/example.ts"),
    patch("src/example.ts") + "x".repeat(100001),
    patch("src/example.ts").replace("@@ -1 +1 @@", "GIT binary patch"),
  ])
    assert.throws(() => validatePatch(bad));
});
test("regular additions are allowed but symlink additions and path mismatch fail", () => {
  const added = patch("src/new.ts")
    .replace(
      "index 1234567..abcdef0 100644",
      "new file mode 100644\nindex 0000000..abcdef0",
    )
    .replace("--- a/src/new.ts", "--- /dev/null")
    .replace("@@ -1 +1 @@\n-old", "@@ -0,0 +1 @@");
  assert.deepEqual(validatePatch(added), ["src/new.ts"]);
  assert.throws(() =>
    validatePatch(
      added.replace("new file mode 100644", "new file mode 120000"),
    ),
  );
  assert.throws(() =>
    validatePatch(added.replace("b/src/new.ts\n", "b/src/other.ts\n")),
  );
});
test("patch is applied to exact clean source only; real Git rejects malformed hunks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynab-autofix-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.test"]);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/example.ts"), "old\n");
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    const head = git(["rev-parse", "HEAD"]);
    const file = join(tmpdir(), `ynab-autofix-${process.pid}.patch`);
    writeFileSync(file, patch("src/example.ts"));
    assert.throws(() => applyPatch(file, dir, "b".repeat(40)));
    writeFileSync(join(dir, "unexpected"), "dirty");
    assert.throws(() => applyPatch(file, dir, head));
    rmSync(join(dir, "unexpected"));
    writeFileSync(file, patch("src/example.ts").replace("-old", "-missing"));
    assert.throws(() => applyPatch(file, dir, head));
    writeFileSync(file, patch("src/example.ts"));
    assert.deepEqual(applyPatch(file, dir, head), ["src/example.ts"]);
    assert.equal(readFileSync(join(dir, "src/example.ts"), "utf8"), "new\n");
    rmSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admission persists a bot claim and suppresses duplicate attempts", async () => {
  const { main } = await import("../scripts/ci-autofix.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ynab-claim-"));
  const before = { ...process.env };
  const originalFetch = globalThis.fetch;
  const comments = [];
  const { run, pr, jobs } = input();
  run.id = 123;
  pr.body = body(metadata());
  writeFileSync(
    join(dir, "event.json"),
    JSON.stringify({ workflow_run: { id: 123 } }),
  );
  Object.assign(process.env, {
    GITHUB_EVENT_PATH: join(dir, "event.json"),
    GITHUB_REPOSITORY: "tzehon/ynab-mcp",
    GITHUB_OUTPUT: join(dir, "output"),
    GH_TOKEN: "synthetic",
  });
  globalThis.fetch = async (url, opts) => {
    assert.equal(new URL(url).origin, "https://api.github.com");
    let data;
    const path = new URL(url).pathname;
    if (path.endsWith("/actions/runs/123")) data = run;
    else if (path.endsWith("/jobs")) data = { jobs };
    else if (path.endsWith(`/commits/${sha}/pulls`)) data = [pr];
    else if (path.endsWith("/pulls/99")) data = pr;
    else if (path.endsWith("/issues/99/comments")) {
      if (opts.method === "POST") {
        comments.push({
          user: { login: "github-actions[bot]" },
          ...JSON.parse(opts.body),
        });
        data = comments.at(-1);
      } else data = comments;
    } else throw new Error("Unexpected API path");
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    await main("admit");
    await main("admit");
    assert.equal(comments.length, 1);
    assert.match(readFileSync(join(dir, "output"), "utf8"), /eligible=true/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env))
      if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publisher rechecks a stale head before creating a branch and never executes candidate source", async () => {
  const { main } = await import("../scripts/ci-autofix.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ynab-publish-"));
  const source = join(dir, "source");
  mkdirSync(source);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "src/example.ts"), "old\n");
  git(["add", "."]);
  git(["commit", "-m", "YNAB-99: Fixture"]);
  const head = git(["rev-parse", "HEAD"]);
  const { run, pr, jobs } = input();
  run.id = 123;
  run.head_sha = head;
  pr.head.sha = head;
  pr.body = body(metadata());
  run.html_url = "https://github.com/tzehon/ynab-mcp/actions/runs/123";
  const before = { ...process.env },
    originalFetch = globalThis.fetch;
  const writes = [];
  let stale = false;
  writeFileSync(
    join(dir, "event.json"),
    JSON.stringify({ workflow_run: { id: 123 } }),
  );
  writeFileSync(join(dir, "fix.patch"), patch("src/example.ts"));
  Object.assign(process.env, {
    GITHUB_EVENT_PATH: join(dir, "event.json"),
    GITHUB_REPOSITORY: "tzehon/ynab-mcp",
    SOURCE_SHA: head,
    SOURCE_DIR: source,
    PATCH_FILE: join(dir, "fix.patch"),
    GH_TOKEN: "synthetic",
  });
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    let data;
    if (opts.method === "POST") {
      writes.push(path);
      data = { sha: "c".repeat(40) };
      if (path.endsWith("/git/commits")) stale = true;
    } else if (path.endsWith("/actions/runs/123")) data = run;
    else if (path.endsWith("/jobs")) data = { jobs };
    else if (path.endsWith(`/commits/${head}/pulls`))
      data = [
        stale ? { ...pr, head: { ...pr.head, sha: "d".repeat(40) } } : pr,
      ];
    else if (path.endsWith("/pulls/99")) data = pr;
    else if (path.endsWith(`/git/commits/${head}`))
      data = { tree: { sha: "b".repeat(40) } };
    else throw new Error("Unexpected API path");
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    await assert.rejects(main("publish"));
    assert.ok(writes.some((p) => p.endsWith("/git/commits")));
    assert.ok(
      !writes.some((p) => p.endsWith("/git/refs") || p.endsWith("/pulls")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env))
      if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata fetch recovers a deleted event head missing from a full branch clone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynab-fetch-"));
  const upstream = join(dir, "origin");
  const clone = join(dir, "clone");
  mkdirSync(upstream);
  const git = (cwd, args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(upstream, ["init", "-b", "main"]);
    git(upstream, ["config", "user.name", "Fixture"]);
    git(upstream, ["config", "user.email", "fixture@example.test"]);
    writeFileSync(join(upstream, "file"), "base");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "YNAB-99: Base"]);
    const base = git(upstream, ["rev-parse", "HEAD"]);
    git(upstream, ["switch", "-c", "feature"]);
    writeFileSync(join(upstream, "file"), "change");
    git(upstream, ["commit", "-am", "YNAB-99: Change"]);
    const head = git(upstream, ["rev-parse", "HEAD"]);
    git(upstream, ["switch", "main"]);
    git(upstream, ["branch", "-D", "feature"]);
    git(dir, ["clone", "--no-local", upstream, clone]);
    assert.throws(() => git(clone, ["cat-file", "-e", head]));
    const event = join(dir, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: { base: { sha: base }, head: { sha: head } },
      }),
    );
    execFileSync(
      process.execPath,
      [resolve("scripts/fetch-pr-event-commits.mjs")],
      {
        cwd: clone,
        env: { ...process.env, GITHUB_EVENT_PATH: event },
        stdio: "pipe",
      },
    );
    assert.equal(git(clone, ["cat-file", "-t", head]), "commit");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: {
          base: { sha: "--upload-pack=evil" },
          head: { sha: head },
        },
      }),
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [resolve("scripts/fetch-pr-event-commits.mjs")],
        {
          cwd: clone,
          env: { ...process.env, GITHUB_EVENT_PATH: event },
          stdio: "pipe",
        },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
