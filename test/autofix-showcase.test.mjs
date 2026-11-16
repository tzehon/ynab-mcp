import assert from "node:assert/strict";
import test from "node:test";
import { addDemoIntegers } from "../dist/autofix-showcase.js";

test("showcase addition preserves positive, negative and zero operands", () => {
  assert.equal(addDemoIntegers(2, 3), 5);
  assert.equal(addDemoIntegers(-4, 7), 3);
  assert.equal(addDemoIntegers(8, 0), 8);
  assert.equal(addDemoIntegers(10, -2), 8);
});
