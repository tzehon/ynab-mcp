import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateMetadata } from './lib/pr-metadata.mjs';

const actions = ['opened', 'synchronize', 'reopened', 'edited'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw new Error('Git range unavailable: use a full checkout containing the event base and head commits.'); }
}
export function collectCommits(event, cwd = process.cwd()) {
  const base = event?.pull_request?.base?.sha, head = event?.pull_request?.head?.sha;
  if (!sha(base) || !sha(head)) throw new Error('Event base/head must be full lowercase 40-character Git SHAs.');
  if (git(['rev-parse', '--is-shallow-repository'], cwd).trim() !== 'false')
    throw new Error('Shallow history is unsupported; fetch full history before checking commits.');
  for (const id of [base, head]) git(['cat-file', '-e', `${id}^{commit}`], cwd);
  // Require connected histories; base need not be an ancestor when main advanced.
  git(['merge-base', base, head], cwd);
  const ids = git(['rev-list', '--reverse', `${base}..${head}`, '--'], cwd).trim().split('\n').filter(Boolean);
  if (!ids.length) throw new Error('PR commit range is empty.');
  // Use explicit head, never HEAD (which may be GitHub's synthetic test merge).
  return ids.map(id => ({ sha: id, message: git(['show', '-s', '--format=%B', id, '--'], cwd).trim() }));
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  let eventPath = env.GITHUB_EVENT_PATH, commitsPath;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--event', '--fixture-commits'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error('Usage: check:pr -- --event <event.json> [--fixture-commits <synthetic-commits.json>]');
    if (flag === '--event') eventPath = argv[++i]; else commitsPath = argv[++i];
  }
  if (commitsPath && (env.CI || env.GITHUB_ACTIONS)) throw new Error('Fixture commits are allowed only in local synthetic demonstrations.');
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Expected a pull_request event.');
  if (!eventPath) throw new Error('Provide --event or GITHUB_EVENT_PATH.');
  let event, commits;
  try { event = JSON.parse(readFileSync(eventPath, 'utf8')); }
  catch { throw new Error('Cannot read event JSON.'); }
  if (!event?.pull_request || !actions.includes(event.action)) throw new Error('Expected an opened, synchronize, reopened or edited PR event.');
  if (commitsPath) {
    try { commits = JSON.parse(readFileSync(commitsPath, 'utf8')); }
    catch { throw new Error('Cannot read synthetic commits JSON.'); }
  } else commits = collectCommits(event, cwd);
  const result = validateMetadata({ title: event.pull_request.title, body: event.pull_request.body, jiraBaseUrl: env.JIRA_BASE_URL, commits });
  return { ...result, action: event.action, head: sha(event.pull_request.head?.sha) ? event.pull_request.head.sha : 'synthetic' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2));
    console.log(`PR metadata: ${result.ok ? 'PASS' : 'FAIL'}; event=${result.action}; head=${result.head}`);
    for (const e of result.errors) console.error(`${e.code}: ${e.message}`);
    console.log(`Reported passed ACs: ${result.passed.join(', ') || 'none'}`);
    console.log(`Pending ACs (not passed): ${result.pending.join(', ') || 'none'}`);
    console.log('Syntax only. Manually verify Jira existence, human approvals, current fields and evidence before merge.');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    // Only our fixed diagnostics; never echo PR text, URLs, Git stderr or file contents.
    console.error(`INPUT: ${error.message}`); process.exitCode = 1;
  }
}
