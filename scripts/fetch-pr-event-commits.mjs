import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// A deleted PR branch is absent from a normal full branch checkout. Fetch the
// immutable event IDs explicitly, never a shell-expanded branch name.
try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const shas = [event.pull_request?.base?.sha, event.pull_request?.head?.sha];
  if (
    !shas.every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))
  )
    throw new Error();
  execFileSync("git", ["fetch", "--no-tags", "origin", ...shas], {
    stdio: ["ignore", "ignore", "pipe"],
  });
} catch {
  console.error("Unable to fetch validated immutable PR event commits.");
  process.exitCode = 1;
}
