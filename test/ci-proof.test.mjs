import assert from "node:assert/strict";
import { test } from "node:test";
import { addIntegers } from "../dist/ci-proof.js";

test("synthetic addition returns the sum of its arguments", () => {
  assert.equal(addIntegers(2, 3), 5);
  assert.equal(addIntegers(-4, 7), 3);
  assert.equal(addIntegers(8, 0), 8);
});
