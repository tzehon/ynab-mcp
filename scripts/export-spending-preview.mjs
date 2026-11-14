import { constants, lstatSync, realpathSync } from "node:fs";
import { open, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spendingValidator, spendingHtml } from "../dist/ui/resource.js";
const limit = 16 * 1024 * 1024;
const prefix = "mcp__claude_ai_MCP_Tools_for_YNAB__";
function fail() {
  throw new Error(
    "Capture refused: require one complete matching analysis, private regular input and a new private output directory.",
  );
}
export async function capturedAnalysis(text) {
  if (Buffer.byteLength(text) > limit) fail();
  const calls = new Map(),
    candidates = [];
  let selected = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (
        event.type === "assistant" &&
        block.type === "tool_use" &&
        typeof block.name === "string" &&
        block.name.startsWith(prefix)
      ) {
        if (typeof block.id !== "string" || calls.has(block.id)) fail();
        calls.set(block.id, {
          name: block.name.slice(prefix.length),
          request: block.input,
          selected: new Set(selected),
          used: false,
        });
      }
      if (event.type !== "user" || block.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      if (call.used) fail();
      call.used = true;
      if (block.is_error) continue;
      const transport = event.tool_use_result;
      if (!transport || typeof transport !== "object" || transport.isError)
        continue;
      const report = transport.structuredContent;
      // Require exact agreement between the native tool-result and the text
      // supplied to the model. Assistant prose is deliberately ignored.
      if (
        typeof block.content !== "string" ||
        !report ||
        JSON.stringify(JSON.parse(block.content)) !== JSON.stringify(report)
      )
        fail();
      if (call.name === "ynab_list_plans") {
        if (
          !["fixtures", "live"].includes(report.data_mode) ||
          report.truncated !== false ||
          !Array.isArray(report.plans) ||
          report.plans.length > 10 ||
          report.plans.some((p) => !p || typeof p.id !== "string")
        )
          fail();
        selected = new Set(report.plans.map((p) => p.id));
      } else if (call.name === "ynab_get_spending_analysis") {
        if (!call.selected.has(call.request?.plan_id)) fail();
        await spendingValidator.validate(report, call.request);
        if (
          typeof event.timestamp !== "string" ||
          !/^\d{4}-\d\d-\d\dT/.test(event.timestamp) ||
          !Number.isFinite(Date.parse(event.timestamp))
        )
          fail();
        candidates.push({
          request: call.request,
          report,
          capturedAt: event.timestamp,
        });
      }
    }
  }
  if (candidates.length !== 1) fail();
  return candidates[0];
}
export async function exportPreview(input, output) {
  const source = resolve(input),
    destination = resolve(output);
  if (
    realpathSync(source) !== source ||
    realpathSync(dirname(destination)) !== dirname(destination)
  )
    fail();
  const fd = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text;
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > limit
    )
      fail();
    // Bounded read even if a writer grows the input after fstat.
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const r = await fd.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
    }
    if (count > limit) fail();
    const after = await fd.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail();
    text = bytes.subarray(0, count).toString("utf8");
  } finally {
    await fd.close();
  }
  const capture = await capturedAnalysis(text);
  const html = spendingHtml(capture);
  await mkdir(destination, { mode: 0o700 }); // EEXIST is intentional; never replace.
  const stat = lstatSync(destination);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700
  )
    fail();
  await writeFile(
    join(destination, "analysis.json"),
    `${JSON.stringify(capture)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(join(destination, "index.html"), html, {
    mode: 0o600,
    flag: "wx",
  });
  return destination;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 4) fail();
    await exportPreview(process.argv[2], process.argv[3]);
    console.log(
      "Private reconciled preview created: open index.html in the new output directory.",
    );
  } catch {
    console.error(
      "No preview exported. Check private capture, matching successful tool results and new output path; input was not modified.",
    );
    process.exitCode = 1;
  }
}
