import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repairMetadata } from "./ci-autofix.mjs";
import { validateMetadata } from "./lib/pr-metadata.mjs";

const repository = "tzehon/ynab-mcp";
const root = `repos/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const approvalMarker = "<!-- autofix-demo-approval:v1 -->";
export const demoFiles = Object.freeze({
  "src/autofix-showcase.ts":
    "export function addDemoIntegers(left: number, right: number): number {\n  return left - right;\n}\n",
  "test/autofix-showcase.test.mjs":
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { addDemoIntegers } from "../dist/autofix-showcase.js";\n\ntest("showcase addition preserves positive, negative and zero operands", () => {\n  assert.equal(addDemoIntegers(2, 3), 5);\n  assert.equal(addDemoIntegers(-4, 7), 3);\n  assert.equal(addDemoIntegers(8, 0), 8);\n  assert.equal(addDemoIntegers(10, -2), 8);\n});\n',
});

export function parseArgs(args) {
  let approvalPr,
    publish = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approval-pr" && approvalPr === undefined) {
      const value = args[++i];
      if (
        !/^[1-9][0-9]*$/.test(value ?? "") ||
        !Number.isSafeInteger(Number(value))
      )
        throw new Error("Invalid approval PR number.");
      approvalPr = Number(value);
    } else if (args[i] === "--publish" && !publish) publish = true;
    else
      throw new Error(
        "Usage: npm run demo:autofix -- --approval-pr NUMBER [--publish]",
      );
  }
  if (!approvalPr)
    throw new Error(
      "Provide the merged demo approval PR with --approval-pr NUMBER.",
    );
  return { approvalPr, publish };
}

function ghApi(path, method = "GET", data) {
  const args = ["api", "--hostname", "github.com", "--method", method, path];
  if (data !== undefined) args.push("--input", "-");
  try {
    return JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        input: data === undefined ? undefined : JSON.stringify(data),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 10_000_000,
      }),
    );
  } catch {
    throw new Error(
      "GitHub request failed; check gh authentication and repository access.",
    );
  }
}

export async function runDemo(
  options,
  {
    api = ghApi,
    nonce = () => randomBytes(12).toString("hex"),
    log = console.log,
  } = {},
) {
  if (
    !Number.isSafeInteger(options.approvalPr) ||
    options.approvalPr < 1 ||
    typeof options.publish !== "boolean"
  )
    throw new Error("Invalid options.");
  const user = await api("user");
  if (user.login !== "tzehon")
    throw new Error("This demo requires the repository owner's GitHub login.");
  const approval = await api(`${root}/pulls/${options.approvalPr}`);
  const key = /^(YNAB-[1-9][0-9]*): /.exec(approval.title ?? "")?.[1];
  if (
    !key ||
    !approval.merged ||
    approval.user?.login !== "tzehon" ||
    approval.base?.ref !== "main" ||
    approval.base?.repo?.full_name !== repository ||
    approval.head?.repo?.full_name !== repository ||
    !approval.body?.includes(approvalMarker)
  )
    throw new Error(
      "Use an owner-authored, merged demo approval PR in this repository.",
    );
  const metadata = repairMetadata(approval.body, key);
  const id = nonce();
  if (!/^[a-f0-9]{24}$/.test(id))
    throw new Error("Invalid unique demo identity.");
  const branch = `${key}-showcase-${id}`;
  const title = `${key}: SHOWCASE — addition failure ${id} (do not merge)`;
  const message = `${key}: SHOWCASE intentional addition failure ${id}`;
  const body = `## Repeatable autofix demonstration\n\nIsolated invented addition bug: 2 + 3 should be 5, but the source returns -1. Preserve all four assertions. Never merge this demonstration into main or deploy it.\n\nFollow the automatic **Autofix started** and **Autofix outcome** comments for the failed CI, repair run and generated draft. The repair targets this feature branch. Normal bot-PR CI may require maintainer workflow approval. After inspection, close the repair, then this PR, without merging; archive evidence before deleting disposable branches.\n\nApproved demonstration scope: [PR #${options.approvalPr}](https://github.com/${repository}/pull/${options.approvalPr}). Carried metadata is context, not a new approval; all criteria are pending. The operator must ensure this approved demo scope still applies.\n\n\`\`\`ynab-metadata\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`;
  const validation = validateMetadata({
    title,
    body,
    jiraBaseUrl: new URL(metadata.issueUrl).origin,
    commits: [{ sha: "a".repeat(40), message }],
  });
  if (!validation.ok)
    throw new Error(
      "Approval metadata does not satisfy the current issue contract.",
    );
  const enabled = await api(`${root}/actions/variables/CODEX_AUTOFIX_ENABLED`);
  const model = await api(`${root}/actions/variables/CODEX_AUTOFIX_MODEL`);
  if (
    enabled.value !== "true" ||
    typeof model.value !== "string" ||
    !model.value.trim()
  )
    throw new Error("Autofix is not configured/enabled; no demo published.");
  const ref = await api(`${root}/git/ref/heads/main`);
  if (!sha.test(ref.object?.sha ?? "")) throw new Error("Invalid main commit.");
  const main = await api(`${root}/git/commits/${ref.object.sha}`);
  if (!sha.test(main.tree?.sha ?? "")) throw new Error("Invalid main tree.");
  const tree = await api(`${root}/git/trees/${main.tree.sha}?recursive=1`);
  if (
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.some((e) => Object.keys(demoFiles).includes(e.path)) ||
    !["src", "test"].every((path) =>
      tree.tree.some((e) => e.path === path && e.type === "tree"),
    )
  )
    throw new Error(
      "Demo paths are occupied or main tree is incomplete/unexpected.",
    );
  log(
    `Preview: ${branch} from main ${ref.object.sha}; two invented files. Explicit --publish creates a PR and can incur existing CI/API usage. No merge or deployment.`,
  );
  const result = { branch, baseSha: ref.object.sha, title, files: demoFiles };
  if (!options.publish) return { ...result, published: false };
  let stage = "create tree";
  try {
    const nextTree = await api(`${root}/git/trees`, "POST", {
      base_tree: main.tree.sha,
      tree: Object.entries(demoFiles).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      })),
    });
    if (!sha.test(nextTree.sha ?? "")) throw new Error();
    stage = "create commit";
    const commit = await api(`${root}/git/commits`, "POST", {
      message,
      tree: nextTree.sha,
      parents: [ref.object.sha],
    });
    if (!sha.test(commit.sha ?? "")) throw new Error();
    stage = "create branch";
    await api(`${root}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    stage = "create PR";
    const pr = await api(`${root}/pulls`, "POST", {
      title,
      body,
      head: branch,
      base: "main",
      draft: false,
    });
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error();
    const url = `https://github.com/${repository}/pull/${pr.number}`;
    log(
      `Published ${url}. Follow its bot comments. Retain evidence before closing without merge.`,
    );
    return { ...result, published: true, sha: commit.sha, url };
  } catch {
    throw new Error(
      `Demo publication stopped at ${stage}. Inspect branch ${branch} and its PRs before retrying; remote creation may have succeeded. No automatic cleanup or merge performed.`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  Promise.resolve()
    .then(() => runDemo(parseArgs(process.argv.slice(2))))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
