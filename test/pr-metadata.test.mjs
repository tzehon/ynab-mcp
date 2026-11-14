import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetadata } from '../scripts/lib/pr-metadata.mjs';
import { origin, metadata, body } from './helpers.mjs';

const valid = () => ({ title: 'YNAB-1: Deliver foundation', body: body(), jiraBaseUrl: origin,
  commits: [{ sha: 'b'.repeat(40), message: 'YNAB-1: Add validator' }] });
const rejects = (input, code) => assert.ok(validateMetadata(input).errors.some(e => e.code === code));
test('valid evidence passes with explicit scope limitation', () => {
  const r = validateMetadata(valid()); assert.equal(r.ok, true); assert.deepEqual(r.pending, []);
  assert.equal(r.issueKey, 'YNAB-1'); assert.equal(r.passed.length, 8);
});
for (const title of ['', 'Foundation', 'YNAB-0: Empty key', 'YNAB-01: Leading zero', 'YNAB-1:', 'YNAB-1: Also YNAB-2', 'YNAB-1: x\nspoof']) {
  test(`reject title ${JSON.stringify(title)}`, () => rejects({ ...valid(), title }, 'TITLE'));
}
for (const jiraBaseUrl of [undefined, '', 'http://example.invalid', 'https://user@example.invalid', `${origin}/path`, `${origin}?q=x`]) {
  test(`fail closed for configuration ${jiraBaseUrl}`, () => rejects({ ...valid(), jiraBaseUrl }, 'CONFIG'));
}
for (const url of ['http://example.invalid/browse/YNAB-1', 'https://example.invalid.evil.test/browse/YNAB-1',
  'https://example.invalid@evil.test/browse/YNAB-1', 'https://user@example.invalid/browse/YNAB-1',
  `${origin}/browse/YNAB-2`, `${origin}/browse/YNAB-10`, `${origin}/browse/YNAB-1?x=y`, `${origin}/browse/YNAB-1#x`]) {
  test(`reject issue URL ${url}`, () => { const m = metadata(); m.issueUrl = url; rejects({ ...valid(), body: body(m) }, 'ISSUE_URL'); });
}
for (const name of ['spec', 'ac', 'plan']) {
  test(`require ${name} revision and links`, () => {
    for (const prop of ['revision', 'snapshotUrl', 'decisionUrl']) {
      const m = metadata(); delete m.approvals[name][prop]; rejects({ ...valid(), body: body(m) }, 'APPROVAL');
    }
    const m = metadata(); m.approvals[name].revision = 'TODO'; rejects({ ...valid(), body: body(m) }, 'APPROVAL');
    m.approvals[name].revision = `${name}-r1`; m.approvals[name].snapshotUrl = 'https://wrong.invalid/snapshot';
    rejects({ ...valid(), body: body(m) }, 'APPROVAL');
  });
}
test('reject malformed, missing, duplicate or unsupported metadata', () => {
  for (const b of ['', '```ynab-metadata\n{\n```', body() + body(), '```ynab-metadata\nnull\n```']) rejects({ ...valid(), body: b }, 'METADATA');
  const m = metadata(); m.schemaVersion = 2; rejects({ ...valid(), body: body(m) }, 'METADATA');
});
test('require all ACs, distinct IDs and non-placeholder check/evidence', () => {
  for (const mutate of [m => m.acceptanceCriteria.pop(), m => m.acceptanceCriteria.push(m.acceptanceCriteria[0]),
    m => { m.acceptanceCriteria[0].check = 'TODO'; }, m => { m.acceptanceCriteria[0].evidence = ''; },
    m => { m.acceptanceCriteria[0].status = 'green'; }]) {
    const m = metadata(); mutate(m); rejects({ ...valid(), body: body(m) }, 'AC');
  }
});
test('pending is outstanding work, failed is failure', () => {
  const m = metadata(); m.acceptanceCriteria[0].status = 'pending';
  rejects({ ...valid(), body: body(m) }, 'AC');
  m.acceptanceCriteria[0].remaining = 'Owner must inspect delivered commit after merge';
  const r = validateMetadata({ ...valid(), body: body(m) });
  assert.equal(r.ok, true); assert.deepEqual(r.pending, ['AC-1']); assert.equal(r.passed.length, 7);
  m.acceptanceCriteria[0].status = 'failed'; rejects({ ...valid(), body: body(m) }, 'AC_FAILED');
});
test('every real commit requires the exact key with token boundaries', () => {
  for (const message of ['No key', 'YNAB-10: wrong', 'X-YNAB-1: wrong', 'YNAB-1-other: wrong'])
    rejects({ ...valid(), commits: [{ sha: 'c'.repeat(40), message }] }, 'COMMIT');
  rejects({ ...valid(), commits: [] }, 'COMMITS');
  rejects({ ...valid(), commits: null }, 'COMMITS');
});
test('shell metacharacters stay ordinary metadata', () => {
  const v = valid(); v.title = 'YNAB-1: $(touch sentinel) `echo hi` ; echo x';
  assert.equal(validateMetadata(v).ok, true);
});

test('YNAB-12 requires all nine chart-delivery acceptance entries', () => {
  const m = metadata();
  m.issueUrl = `${origin}/browse/YNAB-12`;
  for (const approval of Object.values(m.approvals)) approval.decisionUrl = `${origin}/browse/YNAB-12?focusedCommentId=456`;
  m.acceptanceCriteria.push({ ...m.acceptanceCriteria[0], id:'AC-9' });
  const v={title:'YNAB-12: Display reconciled charts',body:body(m),jiraBaseUrl:origin,commits:[{sha:'d'.repeat(40),message:'YNAB-12: Add spending view'}]};
  assert.equal(validateMetadata(v).ok,true);
  m.acceptanceCriteria.pop(); rejects({...v,body:body(m)},'AC');
});
