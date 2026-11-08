import type { IncomingMessage, ServerResponse } from "node:http";
import { calculatePKCECodeChallenge } from "oauth4webapi";
import type Provider from "oidc-provider";
import type { OAuthConfig } from "./config.js";
import { fail } from "./crypto.js";
import { type Lifecycle, random } from "./lifecycle.js";
import type { RecordValue, Store } from "./store.js";
import type { Upstream } from "./upstream.js";
export function securityHeaders(res: ServerResponse) {
  for (const [k, v] of Object.entries({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
  }))
    res.setHeader(k, v);
}
export async function readForm(req: IncomingMessage) {
  if (
    req.method !== "POST" ||
    !req.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    fail();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    const b = Buffer.from(part);
    size += b.length;
    if (size > 16384) fail();
    chunks.push(b);
  }
  const p = new URLSearchParams(Buffer.concat(chunks).toString());
  for (const k of p.keys()) if (p.getAll(k).length !== 1) fail();
  return p;
}
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
function html(res: ServerResponse, body: string) {
  securityHeaders(res);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>YNAB MCP local test</title><body><h1>YNAB MCP — synthetic test data</h1>${body}</body></html>`,
  );
}
function redirect(res: ServerResponse, url: string) {
  securityHeaders(res);
  res.writeHead(303, { Location: url });
  res.end();
}
type Flow = RecordValue & {
  uid: string;
  browser: string;
  csrf: string;
  client: string;
  state?: string;
  verifier?: string;
};
export class Interactions {
  constructor(
    private config: OAuthConfig,
    private provider: Provider,
    private store: Store,
    private upstream: Upstream,
    private lifecycle: Lifecycle,
  ) {}
  private cookie(req: IncomingMessage) {
    const cookies = (req.headers.cookie ?? "")
      .split(/;\s*/)
      .filter((c) => c.startsWith("oauth_local="));
    if (cookies.length !== 1) return;
    const v = cookies[0]?.slice(12) ?? "";
    return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : undefined;
  }
  private setCookie(res: ServerResponse, id: string) {
    res.setHeader(
      "Set-Cookie",
      `oauth_local=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    );
  }
  private post(req: IncomingMessage) {
    if (req.headers.origin !== this.config.origin) fail();
  }
  private session(req: IncomingMessage) {
    const id = this.cookie(req);
    if (!id) fail();
    const s = this.store.get("OwnerSession", id);
    const c = this.lifecycle.current();
    if (
      !s ||
      !c ||
      s.generation !== c.generation ||
      s.owner !== this.config.owner
    )
      fail();
    return { id: id, value: s };
  }
  async handle(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path.startsWith("/interaction/")) {
      const detail = await this.provider.interactionDetails(req, res);
      if (path !== `/interaction/${detail.uid}`) fail();
      if (req.method === "GET") {
        const completed = this.store.get("Completion", detail.uid);
        if (completed) {
          if (
            completed.browser !== this.cookie(req) ||
            completed.client !== detail.params.client_id
          )
            fail();
          this.store.consume("Completion", detail.uid);
          const c = this.lifecycle.connect(
            completed.tokens as import("./upstream.js").Tokens,
          );
          const grant = new this.provider.Grant({
            accountId: this.config.owner,
            clientId: String(completed.client),
          });
          grant.addResourceScope(`${this.config.origin}/mcp`, "ynab:read");
          const grantId = await grant.save();
          this.store.put(
            "McpGrant",
            grantId,
            {
              owner: this.config.owner,
              client: completed.client,
              generation: c.generation,
            },
            this.store.now() + 3600000,
            { grantId },
          );
          const browser = random();
          this.store.put(
            "OwnerSession",
            browser,
            { owner: this.config.owner, generation: c.generation },
            this.store.now() + 3600000,
          );
          this.setCookie(res, browser);
          this.store.remove("Flow", detail.uid);
          this.store.remove("Completion", detail.uid);
          await this.provider.interactionFinished(
            req,
            res,
            { login: { accountId: this.config.owner }, consent: { grantId } },
            { mergeWithLastSubmission: false },
          );
          return true;
        }
        const client = detail.params.client_id;
        if (!["synthetic-native", "synthetic-web"].includes(String(client)))
          fail();
        const browser = this.cookie(req) ?? random(),
          flow: Flow = {
            uid: detail.uid,
            browser,
            csrf: random(),
            client: String(client),
          };
        if (this.store.get("Flow", detail.uid)) fail();
        this.store.put("Flow", detail.uid, flow, this.store.now() + 300000);
        this.setCookie(res, browser);
        html(
          res,
          `<p>Allow ${escapeHtml(flow.client)} to access ${escapeHtml(this.config.origin)}/mcp with read-only permission?</p><form method="post"><input type="hidden" name="csrf" value="${flow.csrf}"><button name="decision" value="continue">Continue with YNAB</button><button name="decision" value="deny">Deny</button></form>`,
        );
        return true;
      }
      this.post(req);
      const form = await readForm(req);
      const flow = this.store.transaction(() => {
        const saved = this.store.get("Flow", detail.uid) as Flow | undefined;
        if (
          !saved ||
          saved.browser !== this.cookie(req) ||
          saved.csrf !== form.get("csrf") ||
          saved.state
        )
          fail();
        this.store.consume("Flow", detail.uid);
        return saved;
      });
      if (form.get("decision") === "deny") {
        this.store.remove("Flow", detail.uid);
        await this.provider.interactionFinished(
          req,
          res,
          { error: "access_denied", error_description: "Consent denied" },
          { mergeWithLastSubmission: false },
        );
        return true;
      }
      if (form.get("decision") !== "continue") fail();
      const state = random(),
        verifier = random();
      this.store.put(
        "UpstreamState",
        state,
        { ...flow, state, verifier },
        this.store.now() + 300000,
      );
      const q = new URLSearchParams({
        client_id: "synthetic-ynab-client",
        response_type: "code",
        scope: "read-only",
        redirect_uri: `${this.config.origin}/connect/ynab/callback`,
        state,
        code_challenge: await calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      redirect(res, `${this.config.upstream}/oauth/authorize?${q}`);
      return true;
    }
    if (path === "/connect/ynab/callback") {
      if (req.method !== "GET") fail();
      const p = new URL(req.url ?? "", this.config.origin).searchParams;
      for (const k of p.keys()) if (p.getAll(k).length !== 1) fail();
      const state = p.get("state");
      if (!state) fail();
      const flow = this.store.transaction(() => {
        const s = this.store.get("UpstreamState", state) as Flow | undefined;
        if (!s || s.browser !== this.cookie(req)) fail();
        this.store.consume("UpstreamState", state);
        return s;
      });
      const tokens = await this.upstream.exchange(
        p,
        state,
        flow.verifier ?? "",
      );
      this.store.put(
        "Completion",
        flow.uid,
        { browser: flow.browser, client: flow.client, tokens },
        this.store.now() + 60000,
      );
      this.store.remove("UpstreamState", state);
      redirect(res, `${this.config.origin}/interaction/${flow.uid}`);
      return true;
    }
    if (path === "/connection") {
      if (req.method !== "GET") fail();
      const s = this.session(req),
        csrf = random();
      this.store.put(
        "OwnerCSRF",
        csrf,
        { browser: s.id },
        this.store.now() + 300000,
      );
      html(
        res,
        `<p>Connected to a synthetic YNAB account. Local disconnect does not revoke access at YNAB.</p><form method="post" action="/connection/refresh"><input type="hidden" name="csrf" value="${csrf}"><button>Refresh connection</button></form><form method="post" action="/connection/disconnect"><input type="hidden" name="csrf" value="${csrf}"><button>Disconnect</button></form>`,
      );
      return true;
    }
    if (["/connection/refresh", "/connection/disconnect"].includes(path)) {
      this.post(req);
      const s = this.session(req),
        form = await readForm(req),
        csrf = form.get("csrf") ?? "";
      this.store.transaction(() => {
        if (this.store.get("OwnerCSRF", csrf)?.browser !== s.id) fail();
        this.store.consume("OwnerCSRF", csrf);
      });
      if (path.endsWith("disconnect")) {
        this.lifecycle.disconnect();
        res.setHeader(
          "Set-Cookie",
          "oauth_local=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
        );
      } else await this.lifecycle.refresh();
      securityHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: path.endsWith("disconnect") ? "disconnected" : "connected",
        }),
      );
      return true;
    }
    return false;
  }
}
