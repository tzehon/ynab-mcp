import type { Analysis } from "../tools/analysis-presentation.js";
import type { validationRuntime } from "./validate.js";
// This function is compiled and embedded, never loaded from the filesystem at runtime.
export function viewRuntime(validator: ReturnType<typeof validationRuntime>) {
  const status = document.getElementById("status") as HTMLElement;
  const panel = document.getElementById("panel") as HTMLElement;
  const buttons = document.getElementById("charts") as HTMLElement;
  const chart = document.getElementById("chart") as HTMLImageElement;
  const answer = document.getElementById("answer") as HTMLElement;
  const evidence = document.getElementById("evidence") as HTMLElement;
  const rows = document.getElementById("values") as HTMLElement;
  let generation = 0,
    request: unknown,
    ready = false,
    ended = false;
  const standalone = document.getElementById("private-capture");
  function clear(message = "Waiting for a complete reconciled report…") {
    generation++;
    panel.hidden = true;
    answer.textContent = "";
    evidence.textContent = "";
    chart.removeAttribute("src");
    chart.alt = "";
    buttons.replaceChildren();
    rows.replaceChildren();
    status.textContent = message;
  }
  function send(message: unknown) {
    if (!standalone && !ended) window.parent.postMessage(message, "*");
  }
  function size() {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: {
        width: document.documentElement.clientWidth,
        height: Math.min(900, document.documentElement.scrollHeight),
      },
    });
  }
  function show(report: Analysis) {
    answer.textContent = report.canonical_answer;
    evidence.textContent = `Source: ${report.source} · Retrieved ${report.as_of} · Evidence ${report.evidence_digest}`;
    for (const item of report.charts) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = {
        monthly: "Monthly spending",
        category: "Categories",
        comparison: "Month comparison",
      }[item.kind];
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        for (const sibling of buttons.querySelectorAll("button"))
          sibling.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", "true");
        rows.replaceChildren();
        const values =
          item.kind === "monthly"
            ? report.months.map(
                (m) =>
                  [m.month.slice(0, 7), m.net_spending_milliunits] as const,
              )
            : item.kind === "category"
              ? report.categories.map(
                  (c) =>
                    [
                      `${c.category_group_name} / ${c.name}`,
                      c.net_spending_milliunits,
                    ] as const,
                )
              : (report.comparison?.category_changes ?? []).map(
                  (c) => [c.name, c.change_milliunits] as const,
                );
        for (const [label, value] of values) {
          const row = document.createElement("tr"),
            name = document.createElement("th"),
            amount = document.createElement("td");
          name.setAttribute("scope", "row");
          name.textContent = label;
          amount.textContent = `${report.currency_code} ${validator.format(value)}`;
          row.append(name);
          row.append(amount);
          rows.append(row);
        }

        chart.alt = `${button.textContent}. ${report.since_date} to ${report.until_date}, ${report.currency_code}.`;
        chart.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.svg)}`;
        document.getElementById("chart-scroll")?.scrollTo(0, 0);
        size();
      });
      buttons.append(button);
    }
    panel.hidden = false;
    status.textContent =
      "Complete reconciled report · scroll to inspect every row";
    (buttons.firstElementChild as HTMLButtonElement | null)?.click();
    size();
  }
  async function result(value: unknown) {
    clear("Checking reconciled report…");
    const current = generation;
    try {
      const r = value as { isError?: boolean; structuredContent?: unknown };
      if (r?.isError || !r?.structuredContent || !request) throw new Error();
      const validated = await validator.validate(r.structuredContent, request);
      if (current !== generation || ended) return;
      show(validated);
    } catch {
      if (current === generation && !ended)
        clear(
          "No complete validated spending view is available. Ask for a fresh reconciled analysis.",
        );
    }
  }
  function receive(event: MessageEvent) {
    if (event.source !== window.parent || ended || standalone) return;
    const m = event.data;
    if (m?.jsonrpc !== "2.0") return;
    if (m.id === 1 && !m.method) {
      if (m.error || m.result?.protocolVersion !== "2026-01-26") {
        clear(
          "This client does not support the spending view. Use the canonical text answer.",
        );
        return;
      }
      ready = true;
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      size();
      return;
    }
    if (!ready) return;
    if (m.method === "ui/notifications/tool-input") {
      request = m.params?.arguments;
      clear();
    } else if (m.method === "ui/notifications/tool-input-partial") {
      request = undefined;
      clear();
    } else if (m.method === "ui/notifications/tool-result")
      void result(m.params);
    else if (m.method === "ui/notifications/tool-cancelled") {
      request = undefined;
      clear("Request cancelled. No spending chart is displayed.");
    } else if (m.method === "ui/resource-teardown") {
      clear("View closed.");
      send({ jsonrpc: "2.0", id: m.id, result: {} });
      ended = true;
      window.removeEventListener("message", receive);
      observer?.disconnect();
    }
  }
  let observer: ResizeObserver | undefined;
  clear();
  if (standalone) {
    try {
      const capture = JSON.parse(standalone.textContent ?? "");
      request = capture.request;
      (document.getElementById("capture-note") as HTMLElement).textContent =
        `Private Claude Code preview · capture ${capture.capturedAt} · not a new provider read`;
      void result({ structuredContent: capture.report });
    } catch {
      clear("Invalid private capture. No spending chart is displayed.");
    }
  } else {
    window.addEventListener("message", receive);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(size);
      observer.observe(document.body);
    }
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        appInfo: { name: "YNAB reconciled spending", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      },
    });
  }
}
