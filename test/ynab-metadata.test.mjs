import test from "node:test";
import assert from "node:assert/strict";
import { validateMetadata } from "../scripts/lib/pr-metadata.mjs";
import { metadata, body, origin } from "./helpers.mjs";
test("Issue-specific AC counts stay exact without relaxing predecessor contracts", () => {
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    for (const count of [8, 9, 10, 11, 12, 13, 14, 15]) {
      const m = metadata();
      m.issueUrl = `${origin}/browse/YNAB-${number}`;
      for (const a of Object.values(m.approvals))
        a.decisionUrl = `${m.issueUrl}?focusedCommentId=456`;
      m.acceptanceCriteria = Array.from({ length: count }, (_, i) => ({
        ...m.acceptanceCriteria[0],
        id: `AC-${i + 1}`,
      }));
      const input = {
        title: `YNAB-${number}: Test contract`,
        body: body(m),
        jiraBaseUrl: origin,
        commits: [{ sha: "a".repeat(40), message: `YNAB-${number}: Test` }],
      };
      assert.equal(
        validateMetadata(input).ok,
        count === (number === 11 ? 10 : number === 6 ? 14 : number === 5 ? 11 : number === 3 ? 9 : 8),
      );
      if (number === 3 && count === 9) {
        m.acceptanceCriteria[8].id = "AC-8";
        assert.equal(validateMetadata({ ...input, body: body(m) }).ok, false);
      }
    }
});
