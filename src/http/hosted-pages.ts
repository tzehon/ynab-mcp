import type { IncomingMessage, ServerResponse } from "node:http";

// Static copy only: never interpolate request data, configuration or identity.
export function hostedPage(body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP Tools for YNAB</title></head><body><header><h1>MCP Tools for YNAB</h1><nav aria-label="Information"><a href="/">About</a> · <a href="/privacy">Privacy policy</a></nav></header><main>${body}</main><footer><p>We are not affiliated, associated, or in any way officially connected with YNAB or any of its subsidiaries or affiliates. The official YNAB website can be found at <a href="https://www.ynab.com">https://www.ynab.com</a>.</p><p>The names YNAB and You Need A Budget, as well as related names, tradenames, marks, trademarks, emblems, and images are registered trademarks of YNAB.</p></footer></body></html>`;
}

const home = hostedPage(`<h2>A private connection for the owner</h2>
<p>This independent, owner-operated project is not affiliated with YNAB. It connects Codex and ChatGPT to five read-only tools. In live mode, the tools read only the plans you select on your private connection page. Fixture mode returns clearly labeled invented data.</p>
<h2>How connecting works</h2>
<p>Start the connection in your configured Codex or ChatGPT client. You approve that client's access here, then sign in and authorize this service on YNAB's website using your existing account. No separate Google or Auth0 sign-in is required.</p>
<p>These are separate permissions: your client receives credentials for this service; YNAB credentials stay on the server. Only the privately enrolled owner can connect. The public pages do not begin enrollment or authorize a client.</p>
<p>Read the <a href="/privacy">privacy policy</a> before connecting. You can disconnect both clients from the authenticated connection page and revoke provider access separately in YNAB.</p>`);

const privacy = hostedPage(`<h2>Privacy policy</h2>
<p>Last updated: 13 November 2026. This policy covers this private, owner-operated service. It is not a public multi-user service.</p>
<h3>Purpose and information used</h3>
<p>The service verifies its owner and authorizes Codex and ChatGPT to use five read-only tools. It processes a YNAB account identifier, OAuth codes and access/refresh credentials, client permissions, short-lived setup information and browser session cookies. It does not collect your YNAB password. In live mode it retrieves selected-plan accounts, month summaries, category metadata and bounded transactions on request. Financial responses are processed transiently and sent to your requesting client; they are not stored in the application database. Plan IDs, names and currencies are saved as encrypted selection metadata. No write tools are provided.</p>
<h3>Storage and sharing</h3>
<p>Authorization records and selected-plan metadata are encrypted on the server's persistent storage. The operator keeps encryption and signing material separately in private runtime settings and 1Password. YNAB credentials remain on the server and are not supplied to Codex or ChatGPT. Those clients receive separate service credentials and tool results, which contain financial information in live mode. Your client may retain results in conversation history under its own policies.</p>
<p>Railway hosts the service and terminates HTTPS, so it processes network traffic and hosts runtime data. YNAB processes sign-in, consent, token, account-identity and requested budget-read operations. OpenAI processes your client interactions under its own policies. This application includes no analytics or advertising. Application logs use bounded operational metadata rather than credentials or financial payloads; hosting and client platforms may keep their own logs. Their retention and deletion are controlled separately, and the operator must verify platform logging before enabling real sign-in.</p>
<h3>Retention</h3>
<p>Authorization codes last up to one minute, interaction records up to five minutes, normal browser sessions and service access tokens up to one hour. Continued-access grants expire after seven idle days or thirty days overall. Expired records become unusable; stored expired records are reclaimed in bounded batches during later writes, not necessarily at the instant of expiry. Selected-plan metadata remains until replacement or disconnect. Temporary plan-selection forms expire after five minutes. Upstream credentials remain until disconnect or invalidation; their usability follows YNAB's expiry and revocation rules. Owner binding and enrollment records persist to prevent unauthorized re-enrollment.</p>
<h3>Disconnect and deletion</h3>
<p>Use Disconnect on the authenticated connection page to invalidate both clients and remove usable locally stored grants, upstream credentials and selected-plan metadata. Owner binding remains. Disconnect does not revoke the application's permission at YNAB; revoke that separately in your YNAB account settings. Logical record deletion does not promise immediate physical erasure from storage or provider logs.</p>
<p>For complete service-data removal, you, the owner and operator, can stop the service and prevent restarts, revoke YNAB access and remove the client connections, then delete the dedicated authorization storage and any private copies or backups you control. Remove associated runtime secrets and private register copies when retiring the service. Follow the <a href="https://github.com/tzehon/ynab-mcp/blob/main/docs/recovery.md#complete-service-data-removal">operator deletion procedure</a>, including provider retention limits. There is no public deletion form, and this service cannot delete conversations or platform logs for you. Reusing the service after erasure requires fresh private enrollment and consent.</p>`);

// Called only after the hosted authority/origin, readiness and admission checks.
export function hostedPublicPage(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) {
  if (path !== "/" && path !== "/privacy") return false;
  if (req.url !== path) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end('{"error":"HTTP_REJECTED"}');
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      Allow: "GET, HEAD",
      "Content-Type": "application/json",
    });
    res.end('{"error":"METHOD_NOT_ALLOWED"}');
    return true;
  }
  const body = path === "/" ? home : privacy;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
