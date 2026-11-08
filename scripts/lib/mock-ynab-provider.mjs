// Synthetic local OAuth provider. Never accepts real account credentials.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const random = () => randomBytes(32).toString("base64url");
export function mockYnab({ port, callback, secret, owner, expires = 3600 }) {
  const origin = `http://127.0.0.1:${port}`,
    pending = new Map(),
    codes = new Map(),
    access = new Map(),
    refresh = new Map();
  const counts = { authorize: 0, exchange: 0, user: 0, refresh: 0 };
  const controls = {
    deny: false,
    wrongOwner: false,
    refreshFailure: false,
    omitReplacement: false,
    delay: 0,
    expires,
  };
  const issue = () => {
    const a = random(),
      r = random();
    access.set(a, true);
    refresh.set(r, true);
    return {
      access_token: a,
      refresh_token: r,
      token_type: "bearer",
      expires_in: controls.expires,
      scope: "read-only",
    };
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) throw Error();
      const u = new URL(req.url, origin);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (u.pathname === "/oauth/authorize" && req.method === "GET") {
        const q = u.searchParams;
        for (const k of q.keys()) if (q.getAll(k).length !== 1) throw Error();
        if (
          q.get("client_id") !== "synthetic-ynab-client" ||
          q.get("redirect_uri") !== callback ||
          q.get("scope") !== "read-only" ||
          q.get("code_challenge_method") !== "S256" ||
          !q.get("code_challenge") ||
          !q.get("state")
        )
          throw Error();
        const id = random(),
          csrf = random();
        pending.set(id, { params: q, csrf, at: Date.now() });
        counts.authorize++;
        res.setHeader(
          "Set-Cookie",
          `mock_ynab=${id}; HttpOnly; SameSite=Lax; Path=/`,
        );
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<h1>Synthetic YNAB account — no real login</h1><form method="post" action="/oauth/authorize"><input name="csrf" value="${csrf}" type="hidden"><button name="decision" value="allow">Allow read-only</button><button name="decision" value="deny">Deny</button></form>`,
        );
        return;
      }
      let form;
      if (req.method === "POST") {
        if (
          !req.headers["content-type"]?.startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          throw Error();
        let size = 0,
          raw = "";
        for await (const b of req) {
          size += b.length;
          if (size > 16384) throw Error();
          raw += b;
        }
        form = new URLSearchParams(raw);
        for (const k of form.keys())
          if (form.getAll(k).length !== 1) throw Error();
      }
      if (u.pathname === "/oauth/authorize" && req.method === "POST") {
        if (req.headers.origin !== origin) throw Error();
        const id = (req.headers.cookie ?? "")
            .split(/;\s*/)
            .find((c) => c.startsWith("mock_ynab="))
            ?.slice(10),
          p = pending.get(id);
        if (!p || p.csrf !== form.get("csrf") || Date.now() - p.at > 300000)
          throw Error();
        pending.delete(id);
        const out = new URL(callback);
        out.searchParams.set("state", p.params.get("state"));
        if (controls.deny || form.get("decision") === "deny")
          out.searchParams.set("error", "access_denied");
        else {
          const c = random();
          codes.set(c, {
            challenge: p.params.get("code_challenge"),
            at: Date.now(),
          });
          out.searchParams.set("code", c);
        }
        res.writeHead(303, { location: out.href });
        res.end();
        return;
      }
      if (u.pathname === "/oauth/token" && req.method === "POST") {
        if (
          form.get("client_id") !== "synthetic-ynab-client" ||
          form.get("client_secret") !== secret
        )
          return json(401, { error: "invalid_client" });
        if (form.get("grant_type") === "authorization_code") {
          const c = codes.get(form.get("code"));
          codes.delete(form.get("code"));
          if (
            !c ||
            Date.now() - c.at > 60000 ||
            form.get("redirect_uri") !== callback ||
            createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url") !== c.challenge
          )
            return json(400, { error: "invalid_grant" });
          counts.exchange++;
          return json(200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          counts.refresh++;
          if (controls.delay)
            await new Promise((r) => setTimeout(r, controls.delay));
          const old = form.get("refresh_token");
          if (controls.refreshFailure || !refresh.has(old))
            return json(400, { error: "invalid_grant" });
          const value = issue();
          if (controls.omitReplacement) {
            delete value.refresh_token;
          } else refresh.delete(old);
          return json(200, value);
        }
      }
      if (u.pathname === "/v1/user" && req.method === "GET") {
        counts.user++;
        if (!access.has(req.headers.authorization?.slice(7)))
          return json(401, { error: "unauthorized" });
        return json(200, {
          data: {
            user: {
              id: controls.wrongOwner
                ? "22222222-2222-4222-8222-222222222222"
                : owner,
            },
          },
        });
      }
      return json(404, { error: "not_found" });
    } catch {
      if (!res.headersSent)
        res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":"MOCK_REJECTED"}');
    }
  });
  server.requestTimeout = 10000;
  return {
    server,
    origin,
    counts,
    controls,
    async start() {
      await new Promise((r, j) => {
        server.once("error", j);
        server.listen(port, "127.0.0.1", r);
      });
    },
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise((r) => server.close(r));
    },
  };
}
