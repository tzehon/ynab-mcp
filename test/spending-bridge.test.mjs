import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { viewRuntime } from "../dist/ui/view.js";
function harness() {
  const elements = new Map();
  const element = () => ({
    hidden: true,
    textContent: "",
    alt: "",
    children: [],
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    replaceChildren() {
      this.children = [];
    },
    append(e) {
      this.children.push(e);
    },
    querySelectorAll() {
      return this.children;
    },
    addEventListener(name, fn) {
      this[name] = fn;
    },
    scrollTo() {},
    get firstElementChild() {
      return this.children[0];
    },
  });
  for (const id of [
    "status",
    "panel",
    "charts",
    "chart",
    "answer",
    "evidence",
    "chart-scroll",
    "values",
  ])
    elements.set(id, element());
  const parent = {},
    sent = [],
    pending = [];
  let listener;
  parent.postMessage = (m) => sent.push(m);
  const window = {
    parent,
    addEventListener: (_, fn) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = undefined;
    },
  };
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: element,
    documentElement: { clientWidth: 600, scrollHeight: 600 },
  };
  const validator = {
    format: (n) => String(n),
    validate: (data, args) =>
      new Promise((resolve, reject) =>
        pending.push({ data, args, resolve, reject }),
      ),
  };
  vm.runInNewContext(`(${viewRuntime.toString()})(validator)`, {
    window,
    document,
    validator,
    encodeURIComponent,
  });
  const send = (m, source = parent) =>
    listener?.({ source, data: { jsonrpc: "2.0", ...m } });
  send({ id: 1, result: { protocolVersion: "2026-01-26" } });
  return { elements, sent, pending, send };
}
const report = {
  canonical_answer: "Synthetic checked answer",
  months: [{month:"2026-08-01",net_spending_milliunits:1250}],
  categories: [], comparison:null,
  source: "mock-ynab",
  as_of: "2026-11-14T00:00:00Z",
  evidence_digest: "a".repeat(64),
  since_date: "2026-08-01",
  until_date: "2026-09-30",
  currency_code: "SGD",
  charts: [{ kind: "monthly", svg: "<svg/>" }],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("bridge accepts only parent, requires initialize and input, and stale validation cannot reveal prior figures", async () => {
  const h = harness();
  assert.equal(h.sent[0].method, "ui/initialize");
  h.send({
    method: "ui/notifications/tool-input",
    params: { arguments: { plan_id: "old" } },
  });
  h.send({
    method: "ui/notifications/tool-result",
    params: { structuredContent: { old: true } },
  });
  assert.equal(h.pending.length, 1);
  h.send({
    method: "ui/notifications/tool-input",
    params: { arguments: { plan_id: "new" } },
  });
  h.pending[0].resolve(report);
  await tick();
  assert.equal(h.elements.get("panel").hidden, true);
  h.send({
    method: "ui/notifications/tool-result",
    params: { structuredContent: { new: true } },
  });
  h.pending[1].resolve(report);
  await tick();
  assert.equal(h.elements.get("panel").hidden, false);
  h.send({ method: "ui/notifications/tool-cancelled" }, {});
  assert.equal(h.elements.get("panel").hidden, false);
  h.send({ method: "ui/notifications/tool-cancelled" });
  assert.equal(h.elements.get("panel").hidden, true);
  assert.equal(h.elements.get("answer").textContent, "");
});
test("an old rejection cannot erase a newer accepted report; teardown prevents any later completion", async () => {
  const h = harness();
  h.send({ method: "ui/notifications/tool-input", params: { arguments: {} } });
  for (let i = 0; i < 2; i++)
    h.send({
      method: "ui/notifications/tool-result",
      params: { structuredContent: { i } },
    });
  h.pending[1].resolve(report);
  await tick();
  h.pending[0].reject(new Error());
  await tick();
  assert.equal(h.elements.get("panel").hidden, false);
  h.send({
    method: "ui/notifications/tool-result",
    params: { structuredContent: { third: true } },
  });
  h.send({ id: 9, method: "ui/resource-teardown" });
  h.pending[2].resolve(report);
  await tick();
  assert.equal(h.elements.get("panel").hidden, true);
  assert.ok(h.sent.some((m) => m.id === 9 && m.result));
});
