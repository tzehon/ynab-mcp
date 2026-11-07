export const origin = 'https://example.invalid';
export function metadata() {
  return {
    schemaVersion: 1,
    issueUrl: `${origin}/browse/YNAB-1`,
    approvals: Object.fromEntries(['spec', 'ac', 'plan'].map(name => [name, {
      revision: `${name}-r1`,
      snapshotUrl: `${origin}/rest/api/3/attachment/content/123`,
      decisionUrl: `${origin}/browse/YNAB-1?focusedCommentId=456`,
    }])),
    acceptanceCriteria: Array.from({ length: 8 }, (_, i) => ({
      id: `AC-${i + 1}`, check: 'Manual synthetic fixture inspection',
      status: 'passed', evidence: 'Synthetic inspection completed for this test',
    })),
  };
}
export function body(value = metadata()) {
  return `Synthetic test data only.\n\n\`\`\`ynab-metadata\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}
export function event(value = metadata()) {
  return {
    action: 'opened', number: 1,
    pull_request: { title: 'YNAB-1: Establish delivery foundations', body: body(value),
      base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } },
  };
}
