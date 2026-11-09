import type { IncomingMessage, ServerResponse } from "node:http";
import { calculatePKCECodeChallenge } from "oauth4webapi";
import type Provider from "oidc-provider";
import { hostedPage } from "../http/hosted-pages.js";
import { sameOriginForm } from "./browser-request.js";
import type { HostedConfig } from "./hosted-config.js";
import type { RefreshFamilies } from "./refresh-families.js";
import { fail } from "./crypto.js";
import { random } from "./lifecycle.js";
import type { HostedLifecycle } from "./hosted-lifecycle.js";
import { readForm, securityHeaders } from "./interactions.js";
import type { RecordValue, Store } from "./store.js";
import type { HostedUpstream } from "./hosted-upstream.js";
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
function html(res: ServerResponse, body: string, formOrigins: string[] = []) {
  securityHeaders(res, formOrigins);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(hostedPage(body));
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
export class HostedInteractions {
  constructor(
    private config: HostedConfig,
    private provider: Provider,
    private store: Store,
    private upstream: HostedUpstream,
    private lifecycle: HostedLifecycle,
    private families: RefreshFamilies,
  ) {}
  private get owner() {
    if (this.config.enrollment.kind !== "owner") fail();
    return this.config.enrollment.owner;
  }
  private cookie(req: IncomingMessage, name = "__Host-ynab_flow") {
    const cookies = (req.headers.cookie ?? "")
      .split(/;\s*/)
      .filter((c) => c.startsWith(`${name}=`));
    if (cookies.length !== 1) return;
    const v = cookies[0]?.slice(name.length + 1) ?? "";
    return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : undefined;
  }
  private setCookie(
    res: ServerResponse,
    id: string,
    name = "__Host-ynab_flow",
  ) {
    res.setHeader(
      "Set-Cookie",
      `${name}=${id}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    );
  }
  private post(req: IncomingMessage) {
    if (req.headers.origin !== this.config.origin && !sameOriginForm(req))
      fail();
  }
  private session(req: IncomingMessage) {
    const id = this.cookie(req, "__Host-ynab_owner");
    if (!id) fail();
    const s = this.store.get("OwnerSession", id);
    const c = this.lifecycle.current();
    if (!s || !c || s.generation !== c.generation || s.owner !== this.owner)
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
            this.owner,
          );
          const grant = new this.provider.Grant({
            accountId: this.owner,
            clientId: String(completed.client),
          });
          grant.addResourceScope(`${this.config.origin}/mcp`, "ynab:read");
          if (String(detail.params.scope).split(" ").includes("offline_access"))
            grant.addOIDCScope("offline_access");
          const grantId = await grant.save();
          if (this.lifecycle.generation() !== c.generation) fail();
          this.families.create(
            grantId,
            String(completed.client),
            this.owner,
            `${this.config.origin}/mcp`,
          );
          const ownerSession = random(),
            previous = this.cookie(req, "__Host-ynab_owner");
          if (previous) this.store.remove("OwnerSession", previous);
          this.store.put(
            "OwnerSession",
            ownerSession,
            { owner: this.owner, generation: c.generation },
            this.store.now() + 3600000,
          );
          this.setCookie(res, ownerSession, "__Host-ynab_owner");
          this.store.remove("Flow", detail.uid);
          this.store.remove("Completion", detail.uid);
          await this.provider.interactionFinished(
            req,
            res,
            { login: { accountId: this.owner }, consent: { grantId } },
            { mergeWithLastSubmission: false },
          );
          return true;
        }
        const client = detail.params.client_id;
        if (![this.config.nativeId, this.config.webId].includes(String(client)))
          fail();
        const candidate = this.cookie(req),
          browser =
            candidate && this.store.get("BrowserBinding", candidate)
              ? candidate
              : random(),
          flow: Flow = {
            uid: detail.uid,
            browser,
            csrf: random(),
            client: String(client),
          };
        if (this.store.get("Flow", detail.uid)) fail();
        this.store.put(
          "BrowserBinding",
          browser,
          {},
          this.store.now() + 3600000,
        );
        this.store.put("Flow", detail.uid, flow, this.store.now() + 300000);
        this.setCookie(res, browser);
        html(
          res,
          `<p>Allow ${escapeHtml(flow.client)} to access ${escapeHtml(this.config.origin)}/mcp with fixture-only read permission? ${String(detail.params.scope).split(" ").includes("offline_access") ? "This includes continued access without this browser session." : "You will reconnect after the access token expires."} You can disconnect both clients from the connection page.</p><form method="post"><input type="hidden" name="csrf" value="${flow.csrf}"><button name="decision" value="continue">Continue with YNAB</button><button name="decision" value="deny">Deny</button></form>`,
          [
            "https://app.ynab.com",
            // The engine has validated this callback. Native clients may use
            // their registered loopback path on a fresh ephemeral port.
            new URL(String(detail.params.redirect_uri)).origin,
          ],
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
        client_id: this.config.ynabId,
        response_type: "code",
        scope: "read-only",
        redirect_uri: `${this.config.origin}/connect/ynab/callback`,
        state,
        code_challenge: await calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      redirect(res, `https://app.ynab.com/oauth/authorize?${q}`);
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
      const result = await this.upstream.exchange(
        p,
        state,
        flow.verifier ?? "",
      );
      if (result.owner !== this.owner) fail();
      this.store.transaction(() => {
        const current = this.store.get("UpstreamState", state);
        if (
          !current?.consumed ||
          current.browser !== flow.browser ||
          current.uid !== flow.uid
        )
          fail();
        this.store.put(
          "Completion",
          flow.uid,
          { browser: flow.browser, client: flow.client, tokens: result.tokens },
          this.store.now() + 60000,
        );
        this.store.remove("UpstreamState", state);
      });
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
        `<p>Connected. Tools return fixtures only. Disconnect here to remove both client grants; revoke this application separately in YNAB settings.</p><form method="post" action="/connection/refresh"><input type="hidden" name="csrf" value="${csrf}"><button>Refresh connection</button></form><form method="post" action="/connection/disconnect"><input type="hidden" name="csrf" value="${csrf}"><button>Disconnect</button></form>`,
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
          ["__Host-ynab_flow", "__Host-ynab_owner"].map(
            (name) =>
              `${name}=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/`,
          ),
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
