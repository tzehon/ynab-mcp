import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "tzehon/ynab-mcp";
const shaPattern = /^[a-f0-9]{40}$/;
const branchPattern = /^YNAB-([1-9][0-9]*)-[A-Za-z0-9_-]+$/;
const maxPatch = 100_000;
const fail = () => {
  throw new Error("Autofix boundary check failed; no publication.");
};

export function eligible(run, pr, jobs) {
  return (
    run.name === "PR checks" &&
    run.path === ".github/workflows/pr-checks.yml" &&
    run.event === "pull_request" &&
    run.conclusion === "failure" &&
    run.run_attempt === 1 &&
    run.actor?.login === "tzehon" &&
    run.triggering_actor?.login === "tzehon" &&
    run.head_repository?.full_name === repository &&
    shaPattern.test(run.head_sha) &&
    pr.state === "open" &&
    !pr.merged &&
    pr.user?.login === "tzehon" &&
    pr.base?.repo?.full_name === repository &&
    pr.base.ref === "main" &&
    pr.head?.repo?.full_name === repository &&
    pr.head.sha === run.head_sha &&
    pr.head.ref === run.head_branch &&
    branchPattern.test(pr.head.ref) &&
    !pr.head.ref.includes("-autofix-") &&
    pr.title?.startsWith(`YNAB-${branchPattern.exec(pr.head.ref)?.[1]}: `) &&
    jobs.some(
      (j) => j.name === "bootstrap-tests" && j.conclusion === "failure",
    ) &&
    jobs.some((j) => j.name === "pr-metadata" && j.conclusion === "success")
  );
}

export function repairMetadata(body, key) {
  const blocks = [
    ...String(body).matchAll(/^```ynab-metadata\r?\n([\s\S]*?)^```[ \t]*$/gm),
  ];
  if (blocks.length !== 1) fail();
  const m = JSON.parse(blocks[0][1]);
  const issue = new URL(m.issueUrl);
  if (
    m.schemaVersion !== 1 ||
    issue.protocol !== "https:" ||
    issue.username ||
    issue.password ||
    !issue.hostname.endsWith(".atlassian.net") ||
    issue.pathname !== `/browse/${key}` ||
    issue.search ||
    issue.hash ||
    !Array.isArray(m.acceptanceCriteria) ||
    m.acceptanceCriteria.length < 1 ||
    m.acceptanceCriteria.length > 14
  )
    fail();
  for (const name of ["spec", "ac", "plan"]) {
    const a = m.approvals?.[name];
    if (!a || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.revision)) fail();
    for (const field of ["snapshotUrl", "decisionUrl"]) {
      const url = new URL(a[field]);
      if (url.origin !== issue.origin || url.username || url.password) fail();
      if (
        field === "decisionUrl" &&
        (url.pathname !== issue.pathname ||
          !/^[1-9][0-9]*$/.test(url.searchParams.get("focusedCommentId") ?? ""))
      )
        fail();
    }
  }
  return {
    schemaVersion: 1,
    issueUrl: m.issueUrl,
    approvals: m.approvals,
    acceptanceCriteria: m.acceptanceCriteria.map((a, i) => {
      if (
        a.id !== `AC-${i + 1}` ||
        typeof a.check !== "string" ||
        a.check.length > 500
      )
        fail();
      return {
        id: a.id,
        check: a.check,
        status: "pending",
        evidence:
          "Automated repair candidate only; original approval links are retained for review.",
        remaining:
          "Revalidate this repair against current Jira scope and acceptance evidence before merge.",
      };
    }),
  };
}

// Restrict the patch format before git sees it. No quoted paths, binary/mode changes,
// deletions, configs, dependency files, workflow changes or instruction files.
export function validatePatch(patch) {
  if (
    typeof patch !== "string" ||
    Buffer.byteLength(patch) > maxPatch ||
    !patch.startsWith("diff --git ") ||
    /\r|\0/.test(patch)
  )
    fail();
  const chunks = patch.split(/^diff --git /m).slice(1);
  if (!chunks.length || chunks.length > 20) fail();
  const paths = new Set();
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const match = /^a\/(\S+) b\/(\S+)$/.exec(lines[0]);
    if (!match || match[1] !== match[2]) fail();
    const path = match[1];
    if (
      !/^(src\/[A-Za-z0-9_/-]+\.ts|test\/[A-Za-z0-9_/-]+\.test\.mjs)$/.test(
        path,
      ) ||
      path.split("/").some((x) => x === ".." || x === ".") ||
      paths.has(path)
    )
      fail();
    paths.add(path);
    const hunk = lines.findIndex((x) =>
      /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(x),
    );
    if (hunk < 0) fail();
    const header = lines.slice(1, hunk);
    const added = header[0] === "new file mode 100644";
    const expected = added ? 4 : 3;
    if (
      header.length !== expected ||
      !/^index [a-f0-9]+\.\.[a-f0-9]+( 100644)?$/.test(header[added ? 1 : 0]) ||
      header[expected - 2] !== `--- ${added ? "/dev/null" : `a/${path}`}` ||
      header[expected - 1] !== `+++ b/${path}`
    )
      fail();
    if (!added && !header[0].endsWith(" 100644")) fail();
  }
  return [...paths];
}

function git(args, cwd) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
}

export function applyPatch(patchFile, cwd, expectedSha) {
  if (
    !shaPattern.test(expectedSha) ||
    git(["rev-parse", "HEAD"], cwd).trim() !== expectedSha
  )
    fail();
  const patch = readFileSync(patchFile, "utf8");
  const paths = validatePatch(patch);
  if (git(["status", "--porcelain"], cwd).trim()) fail();
  git(["apply", "--check", "--index", resolve(patchFile)], cwd);
  git(["apply", "--index", resolve(patchFile)], cwd);
  const actual = git(["diff", "--cached", "--name-only"], cwd)
    .trim()
    .split("\n");
  if (JSON.stringify(actual.sort()) !== JSON.stringify(paths.sort())) fail();
  for (const path of paths) {
    if (!git(["ls-files", "--stage", "--", path], cwd).startsWith("100644 "))
      fail();
  }
  return paths;
}

async function api(path, method = "GET", body) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub autofix operation failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

async function pages(path, field) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const result = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const rows = field ? result[field] : result;
    if (!Array.isArray(rows)) fail();
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  fail();
}

async function context() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const id = event.workflow_run?.id;
  if (!Number.isSafeInteger(id) || process.env.GITHUB_REPOSITORY !== repository)
    fail();
  const run = await api(`actions/runs/${id}`);
  const jobs = await pages(`actions/runs/${id}/attempts/1/jobs`, "jobs");
  const associated = await pages(`commits/${run.head_sha}/pulls`);
  const candidates = associated.filter((pr) => eligible(run, pr, jobs));
  if (candidates.length !== 1) return null;
  const pr = await api(`pulls/${candidates[0].number}`);
  if (!eligible(run, pr, jobs)) return null;
  const key = `YNAB-${branchPattern.exec(pr.head.ref)[1]}`;
  const metadata = repairMetadata(pr.body, key);
  return { run, pr, key, metadata, branch: `${key}-autofix-${run.head_sha}` };
}

export async function main(mode) {
  if (mode === "export") {
    if (
      !shaPattern.test(process.env.SOURCE_SHA) ||
      git(["rev-parse", "HEAD"], process.env.SOURCE_DIR).trim() !==
        process.env.SOURCE_SHA
    )
      fail();
    git(["add", "-N", "."], process.env.SOURCE_DIR);
    const patch = git(
      ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"],
      process.env.SOURCE_DIR,
    );
    if (!patch) {
      console.log("No repair proposed.");
      return;
    }
    validatePatch(patch);
    writeFileSync(process.env.PATCH_FILE, patch, { flag: "wx" });
    appendFileSync(process.env.GITHUB_OUTPUT, "has_patch=true\n");
    return;
  }
  if (mode === "apply") {
    applyPatch(
      process.env.PATCH_FILE,
      process.env.SOURCE_DIR,
      process.env.SOURCE_SHA,
    );
    return;
  }
  const ctx = await context();
  if (!ctx) {
    console.log("Autofix skipped: ineligible or superseded failure.");
    return;
  }
  const { run, pr, key, metadata, branch } = ctx;
  if (mode === "admit") {
    const marker = `<!-- codex-autofix:${run.head_sha} -->`;
    const comments = await pages(`issues/${pr.number}/comments`);
    if (
      comments.some(
        (c) =>
          c.user?.login === "github-actions[bot]" && c.body.includes(marker),
      )
    ) {
      console.log("Autofix skipped: this source SHA already had an attempt.");
      return;
    }
    await api(`issues/${pr.number}/comments`, "POST", {
      body: `${marker}\nOne bounded Codex CI-repair attempt started. Any result will be a draft PR; existing review/approval requirements remain. This marker also prevents repeated API use if generation fails.`,
    });
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `eligible=true\nsha=${run.head_sha}\npr=${pr.number}\n`,
    );
    return;
  }
  if (mode !== "publish" || run.head_sha !== process.env.SOURCE_SHA) fail();
  const paths = applyPatch(
    process.env.PATCH_FILE,
    process.env.SOURCE_DIR,
    run.head_sha,
  );
  const base = await api(`git/commits/${run.head_sha}`);
  const tree = [];
  for (const path of paths) {
    const content = git(["show", `:${path}`], process.env.SOURCE_DIR);
    const blob = await api("git/blobs", "POST", { content, encoding: "utf-8" });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await api("git/trees", "POST", {
    base_tree: base.tree.sha,
    tree,
  });
  const commit = await api("git/commits", "POST", {
    message: `${key}: Propose bounded CI repair for #${pr.number}`,
    tree: newTree.sha,
    parents: [run.head_sha],
  });
  // Recheck immediately before creating the ref; a racing human update never gets overwritten.
  const current = await context();
  if (
    !current ||
    current.run.head_sha !== run.head_sha ||
    current.pr.number !== pr.number
  )
    fail();
  await api("git/refs", "POST", {
    ref: `refs/heads/${branch}`,
    sha: commit.sha,
  });
  const body =
    `Automated repair candidate for #${pr.number}, after [CI failure](${run.html_url}).\n\n` +
    `Targets the original feature branch; never merge directly to main or deploy. Source/test-only patch passed isolated validation. Review every change for weakened tests or changed financial/auth behavior. Original approval links below are context, not new approval.\n\n` +
    `GitHub-token-created PR checks require a maintainer to select Approve workflows to run. Revalidate Jira scope, complete normal CI and native code/security reviews, then rebase-integrate and clean up. No approval is inferred from this candidate.\n\n` +
    `Issue: ${metadata.issueUrl}\n\n\`\`\`ynab-metadata\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`;
  const result = await api("pulls", "POST", {
    title: `${key}: CI repair for #${pr.number}`,
    head: branch,
    base: pr.head.ref,
    draft: true,
    body,
    maintainer_can_modify: true,
  });
  console.log(
    `Draft repair PR #${result.number} created. Review and normal CI remain required.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv[2]).catch(() => {
    console.error(
      "Autofix stopped; inspect the eligible run and permissions. No automatic merge or deployment.",
    );
    process.exitCode = 1;
  });
}
