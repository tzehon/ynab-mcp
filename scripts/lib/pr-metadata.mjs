const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const meaningful = value => text(value) && !/\b(?:TODO|TBD|CHANGEME|REPLACE_ME)\b|<[^>]*>/i.test(value)
  && !/^(?:n\/?a|none|placeholder|\.\.\.)$/i.test(value.trim());

// No network calls: a valid URL is not proof of existence, approval or evidence.
function httpsUrl(value) {
  if (!text(value) || /[\s\\]/.test(value) || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function validateMetadata({ title, body, jiraBaseUrl, commits } = {}) {
  const errors = [], pending = [], passed = [];
  const error = (code, message) => errors.push({ code, message });
  const origin = httpsUrl(jiraBaseUrl);
  if (origin?.pathname !== '/' || origin.search || origin.hash)
    error('CONFIG', 'Set JIRA_BASE_URL to the trusted HTTPS Jira origin without a path, query or credentials.');
  const match = typeof title === 'string' && /^YNAB-([1-9][0-9]*): ([^\r\n]+)$/.exec(title);
  const keys = typeof title === 'string' ? title.match(/YNAB-[0-9]+/g) : null;
  const issueKey = match ? `YNAB-${match[1]}` : null;
  // Explicit approved issue contract; future changes require review.
  const acCount = issueKey === 'YNAB-12' ? 9 : issueKey === 'YNAB-11' ? 10 : issueKey === 'YNAB-6' ? 14 : issueKey === 'YNAB-5' ? 11 : issueKey === 'YNAB-3' ? 9 : 8;
  const acIds = Array.from({ length: acCount }, (_, i) => `AC-${i + 1}`);
  if (!match || !meaningful(match[2]) || keys?.length !== 1)
    error('TITLE', 'Use YNAB-<positive integer>: <summary>, with exactly one primary key and one line.');

  const blocks = typeof body === 'string' ? [...body.matchAll(/^```ynab-metadata\r?\n([\s\S]*?)^```[ \t]*$/gm)] : [];
  let metadata;
  try {
    if (blocks.length !== 1) throw new Error();
    metadata = JSON.parse(blocks[0][1]);
    if (!object(metadata) || metadata.schemaVersion !== 1) throw new Error();
  } catch { error('METADATA', 'Provide exactly one valid ynab-metadata JSON block with schemaVersion 1.'); }

  const sameSite = value => { const u = httpsUrl(value); return u && origin && u.origin === origin.origin ? u : null; };
  if (object(metadata) && metadata.schemaVersion === 1) {
    const issue = sameSite(metadata.issueUrl);
    if (!issue || issue.pathname !== `/browse/${issueKey}` || issue.search || issue.hash)
      error('ISSUE_URL', 'issueUrl must match the title key at the configured Jira /browse/<key> URL.');
    for (const name of ['spec', 'ac', 'plan']) {
      const approval = metadata.approvals?.[name];
      const snapshot = sameSite(approval?.snapshotUrl), decision = sameSite(approval?.decisionUrl);
      if (!object(approval) || !meaningful(approval.revision) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(approval.revision)
        || !snapshot || !meaningful(approval.snapshotUrl) || snapshot.pathname === '/'
        || !decision || !meaningful(approval.decisionUrl) || decision.pathname !== `/browse/${issueKey}`
        || !/^[1-9][0-9]*$/.test(decision.searchParams.get('focusedCommentId') ?? ''))
        error('APPROVAL', `${name} needs a revision, same-site snapshot URL and issue decision URL with focusedCommentId.`);
    }
    const entries = metadata.acceptanceCriteria;
    if (!Array.isArray(entries) || entries.length !== acIds.length ||
      !acIds.every(id => entries.filter(e => e?.id === id).length === 1)) {
      error('AC', `Include exactly one entry for each AC-1 through AC-${acCount}.`);
    }
    if (Array.isArray(entries)) for (const entry of entries) {
      if (!object(entry) || !acIds.includes(entry.id) || !meaningful(entry.check) || !meaningful(entry.evidence)
        || !['passed', 'failed', 'pending'].includes(entry.status)
        || (entry.status === 'pending' && !meaningful(entry.remaining))) {
        error('AC', 'Each AC needs a concrete check, evidence, status and remaining work when pending.');
        continue;
      }
      if (entry.status === 'failed') error('AC_FAILED', `${entry.id} is marked failed; resolve it before validation passes.`);
      if (entry.status === 'pending') pending.push(entry.id);
      if (entry.status === 'passed') passed.push(entry.id);
    }
  }
  if (!Array.isArray(commits) || commits.length === 0) error('COMMITS', 'Supply a nonempty verified PR commit range.');
  else for (const [index, commit] of commits.entries()) {
    // Hyphens and word characters prevent matching a different/extended issue key.
    const key = issueKey && new RegExp(`(^|[^A-Za-z0-9_-])${issueKey}(?=$|[^A-Za-z0-9_-])`);
    if (!object(commit) || !/^[a-f0-9]{40}$/.test(commit.sha ?? '') || !text(commit.message) || !key?.test(commit.message))
      error('COMMIT', `Commit ${index + 1} must have a valid SHA and contain the exact primary issue key.`);
  }
  return { ok: errors.length === 0, issueKey, errors, pending, passed };
}
