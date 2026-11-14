import { createHash } from "node:crypto";
import { z } from "zod";
import { presentationRuntime } from "../tools/analysis-presentation.js";
import { inputSchema, outputSchema } from "../tools/spending-analysis.js";
import { validationRuntime, type JsonSchema } from "./validate.js";
import { viewRuntime } from "./view.js";
export const spendingResourceUri = "ui://spending/analysis-v1.html";
export const spendingMimeType = "text/html;profile=mcp-app";
export const viewSchema = z.toJSONSchema(outputSchema) as JsonSchema;
export const requestSchema = z.toJSONSchema(inputSchema, {
  io: "input",
}) as JsonSchema;
export const spendingValidator = validationRuntime(
  viewSchema,
  requestSchema,
  presentationRuntime(),
);
const json = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
const script = `(${viewRuntime.toString()})((${validationRuntime.toString()})(${json(viewSchema)},${json(requestSchema)},(${presentationRuntime.toString()})()));`;
const css = `:root{color-scheme:light;font:15px system-ui,sans-serif;color:#17212b;background:white}body{margin:0;padding:16px}h1{font-size:20px;margin:0 0 8px}p{line-height:1.5}#status,#capture-note{font-size:13px}nav{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}button{padding:10px 14px;border:1px solid #687080;border-radius:6px;background:#fff;color:#17212b;cursor:pointer}button[aria-pressed=true]{background:#176b91;color:white}button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:3px solid #a45200;outline-offset:2px}#chart-scroll{max-height:560px;overflow:auto;border:1px solid #d0d4d8;border-radius:6px}img{display:block;width:768px;max-width:none}#answer{white-space:pre-wrap}#evidence{overflow-wrap:anywhere;font-size:12px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:8px;text-align:left;vertical-align:top;border-bottom:1px solid #d0d4d8;overflow-wrap:anywhere}th{width:65%;font-weight:normal}.values-scroll{max-height:360px;overflow:auto}summary{cursor:pointer;padding:12px 0}[hidden]{display:none!important}`;
const hash = (text: string) =>
  createHash("sha256").update(text).digest("base64");
export function spendingHtml(capture?: {
  request: unknown;
  report: unknown;
  capturedAt: string;
}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(css)}'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Reconciled spending</title><style>${css}</style></head><body><h1>Reconciled spending</h1><p id="capture-note"></p><p id="status" role="status" aria-live="polite"></p><main id="panel" hidden><nav id="charts" aria-label="Choose spending chart"></nav><div id="chart-scroll" tabindex="0" role="region" aria-label="Spending chart, scroll horizontally and vertically to inspect every row"><img id="chart" alt=""></div><details><summary>Exact chart values and full labels</summary><div class="values-scroll" tabindex="0" role="region" aria-label="All exact chart values"><table aria-label="Exact values from this chart"><tbody id="values"></tbody></table></div></details><details open><summary>Reconciled answer</summary><p id="answer"></p></details><p id="evidence"></p></main>${capture ? `<script type="application/json" id="private-capture">${json(capture)}</script>` : ""}<script>${script}</script></body></html>`;
  if (Buffer.byteLength(html) > (capture ? 524288 : 65536))
    throw new Error("Spending view exceeds its size limit");
  return html;
}
export const spendingResource = {
  uri: spendingResourceUri,
  mimeType: spendingMimeType,
  text: spendingHtml(),
  _meta: {
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      permissions: {},
    },
  },
};
