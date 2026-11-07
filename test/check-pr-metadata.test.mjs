import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectCommits, run } from '../scripts/check-pr-metadata.mjs';
import { origin, event } from './helpers.mjs';

const cli = fileURLToPath(new URL('../scripts/check-pr-metadata.mjs', import.meta.url));
function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ynab-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic Tester'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  const commit = message => { git('commit', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const base = commit('Synthetic seed'); git('switch', '-c', 'YNAB-1-test');
  const head = commit('YNAB-1: Implement synthetic foundation');
  const e = event(); e.pull_request.base.sha = base; e.pull_request.head.sha = head;
  const save = () => writeFileSync(join(cwd, 'event.json'), JSON.stringify(e)); save();
  return { cwd, git, commit, e, base, head, save };
}
function invoke(cwd, args = ['--event', 'event.json'], env = {}) {
  const cleanEnv = { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '', JIRA_BASE_URL: origin, ...env };
  return spawnSync(process.execPath, [cli, ...args], { cwd, env: cleanEnv, encoding: 'utf8' });
}
test('CLI checks real history and returns useful exit codes without leaking site/body', t => {
  const w = workspace(t); const good = invoke(w.cwd);
  assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /Syntax only/);
  assert.match(good.stdout, new RegExp(w.head)); assert.ok(!good.stdout.includes(origin));
  w.e.pull_request.title = 'Invalid private text'; w.save(); const bad = invoke(w.cwd);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /TITLE/); assert.ok(!bad.stderr.includes('private text'));
  assert.match(invoke(w.cwd, undefined, { JIRA_BASE_URL: '' }).stderr, /CONFIG/);
});
test('explicit head excludes synthetic checkout merge, retains all contributor commits', t => {
  const w = workspace(t); const second = w.commit('YNAB-1: Follow-up'); w.e.pull_request.head.sha = second;
  w.git('switch', 'main'); const advancedBase = w.commit('Unrelated base change');
  w.git('merge', '--no-ff', 'YNAB-1-test', '-m', 'Synthetic platform merge without key');
  w.e.pull_request.base.sha = advancedBase;
  assert.deepEqual(collectCommits(w.e, w.cwd).map(c => c.sha), [w.head, second]);
  w.git('switch', 'YNAB-1-test'); const bad = w.commit('Contributor change without key'); w.e.pull_request.head.sha = bad; w.save();
  assert.match(invoke(w.cwd).stderr, /COMMIT/);
});
test('reject missing history, empty range, unrelated history and unsafe SHAs', t => {
  const w = workspace(t);
  for (const head of ['c'.repeat(40), 'HEAD', '--all', '$(touch sentinel)']) {
    w.e.pull_request.head.sha = head; assert.throws(() => collectCommits(w.e, w.cwd));
  }
  w.e.pull_request.head.sha = w.base; assert.throws(() => collectCommits(w.e, w.cwd), /empty/);
  w.git('checkout', '--orphan', 'unrelated'); w.e.pull_request.head.sha = w.commit('YNAB-1: unrelated');
  assert.throws(() => collectCommits(w.e, w.cwd), /unavailable/);
  assert.equal(existsSync(join(w.cwd, 'sentinel')), false);
});
test('shallow clone fails rather than skipping history', t => {
  const w = workspace(t); const shallow = join(w.cwd, 'shallow');
  w.git('clone', '--depth', '1', `file://${w.cwd}`, shallow);
  assert.throws(() => collectCommits(w.e, shallow), /Shallow/);
});
test('PR text containing shell commands cannot execute through CLI', t => {
  const w = workspace(t); w.e.pull_request.title = 'YNAB-1: $(touch sentinel) `touch sentinel2`; touch sentinel3';
  w.e.pull_request.body += '\n$(touch sentinel4)'; w.save();
  assert.equal(invoke(w.cwd).status, 0);
  for (const f of ['sentinel', 'sentinel2', 'sentinel3', 'sentinel4']) assert.equal(existsSync(join(w.cwd, f)), false);
});
test('all four event types work; unsupported events and missing input fail', t => {
  const w = workspace(t);
  for (const action of ['opened', 'synchronize', 'reopened', 'edited']) {
    w.e.action = action; w.save(); assert.equal(invoke(w.cwd).status, 0);
  }
  w.e.action = 'closed'; w.save(); assert.equal(invoke(w.cwd).status, 1);
  assert.equal(invoke(w.cwd, []).status, 1);
  assert.equal(invoke(w.cwd, ['--bad']).status, 1);
  writeFileSync(join(w.cwd, 'event.json'), '{'); assert.equal(invoke(w.cwd).status, 1);
});
test('synthetic commits cannot replace real history in CI', t => {
  const w = workspace(t); writeFileSync(join(w.cwd, 'commits.json'), JSON.stringify([{ sha: w.head, message: 'YNAB-1: Synthetic' }]));
  const args = ['--event', 'event.json', '--fixture-commits', 'commits.json'];
  assert.equal(invoke(w.cwd, args).status, 0);
  assert.match(invoke(w.cwd, args, { CI: 'true' }).stderr, /only in local/);
  assert.throws(() => run(args, { GITHUB_ACTIONS: 'true' }, w.cwd), /only in local/);
  assert.match(invoke(w.cwd, undefined, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request_target' }).stderr, /Expected a pull_request/);
});
