import type { IncomingMessage, ServerResponse } from "node:http";
import { calculatePKCECodeChallenge } from "oauth4webapi";
import { sameOriginForm } from "./browser-request.js";
import { fail } from "./crypto.js";
import type { Enrollment } from "./enrollment.js";
import type { HostedConfig } from "./hosted-config.js";
import type { HostedUpstream } from "./hosted-upstream.js";
import { readForm, securityHeaders } from "./interactions.js";
import { random } from "./lifecycle.js";
import type { Store } from "./store.js";

export class EnrollmentHttp {
  constructor(
    private config: HostedConfig,
    private store: Store,
    private enrollment: Enrollment,
    private upstream: HostedUpstream,
  ) {}
  private browser(req: IncomingMessage) {
    const entries = (req.headers.cookie ?? "")
      .split(/;\s*/)
      .filter((s) => s.startsWith("__Host-ynab_enroll="));
    if (entries.length !== 1) return;
    const value = entries[0]?.split("=")[1];
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  async handle(req: IncomingMessage, res: ServerResponse, path: string) {
    securityHeaders(res, ["https://app.ynab.com"]);
    if (this.config.enrollment.kind !== "enroll") fail();
    if (path === "/enroll" && req.method === "GET") {
      const browser = random(),
        csrf = random();
      this.store.put(
        "EnrollmentForm",
        csrf,
        { browser },
        this.store.now() + 300000,
      );
      res.setHeader(
        "Set-Cookie",
        `__Host-ynab_enroll=${browser}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`,
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>YNAB MCP setup</title><h1>Private owner setup</h1><p>Enter the one-time capability supplied privately by your operator. No budget data is requested.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Setup capability <input name="capability" type="password" autocomplete="off" required></label><button>Continue with YNAB</button></form></html>`,
      );
      return;
    }
    if (path === "/enroll" && req.method === "POST") {
      if (
        req.headers.origin !== this.config.origin &&
        !sameOriginForm(req, true)
      )
        fail();
      const form = await readForm(req),
        csrf = form.get("csrf") ?? "",
        browser = this.browser(req);
      this.store.transaction(() => {
        if (
          !browser ||
          this.store.get("EnrollmentForm", csrf)?.browser !== browser
        )
          fail();
        this.store.consume("EnrollmentForm", csrf);
      });
      const flow = this.enrollment.claim(
          form.get("capability") ?? "",
          browser as string,
        ),
        state = random(),
        verifier = random();
      this.store.put(
        "EnrollmentState",
        state,
        { flow, browser, verifier },
        this.store.now() + 300000,
      );
      const query = new URLSearchParams({
        client_id: this.config.ynabId,
        response_type: "code",
        scope: "read-only",
        state,
        redirect_uri: `${this.config.origin}/connect/ynab/callback`,
        code_challenge: await calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      res.writeHead(303, {
        Location: `https://app.ynab.com/oauth/authorize?${query}`,
      });
      res.end();
      return;
    }
    if (path === "/connect/ynab/callback" && req.method === "GET") {
      const params = new URL(req.url ?? "", this.config.origin).searchParams;
      for (const key of params.keys())
        if (params.getAll(key).length !== 1) fail();
      const state = params.get("state") ?? "",
        browser = this.browser(req);
      const saved = this.store.transaction(() => {
        const row = this.store.get("EnrollmentState", state);
        if (!row || !browser || row.browser !== browser) fail();
        this.store.consume("EnrollmentState", state);
        return row;
      });
      const result = await this.upstream.exchange(
        params,
        state,
        String(saved.verifier),
      );
      this.enrollment.candidate(
        String(saved.flow),
        browser as string,
        result.owner,
      );
      this.store.remove("EnrollmentState", state);
      // No tokens or owner session are persisted by bootstrap.
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>YNAB MCP setup</title><h1>Awaiting operator confirmation</h1><p>Your operator must confirm the intended account privately. No MCP access has been granted.</p></html>',
      );
      return;
    }
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end('{"error":"enrollment_required"}');
  }
}
