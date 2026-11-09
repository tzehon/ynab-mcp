// Test-only real pinned-engine harness. No upstream service or production keys.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import Provider from "oidc-provider";
import { Store } from "../../dist/oauth/store.js";
import { hostedAdapter } from "../../dist/oauth/hosted-adapter.js";
import { RefreshFamilies } from "../../dist/oauth/refresh-families.js";
import {
  hostedPolicy,
  requireConsent,
} from "../../dist/oauth/hosted-policy.js";

export async function providerHarness(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ynab-engine-")));
  let beforeCleanup = async () => {};
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key"),
      "-out",
      join(root, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(root, "cert"));
  let dispatch;
  const server = createServer(
    { cert, key: readFileSync(join(root, "key")) },
    (req, res) => dispatch(req, res),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const origin = `https://127.0.0.1:${server.address().port}`,
    resource = `${origin}/mcp`;
  const signing = await generateKeyPair("RS256", { extractable: true });
  const rows = new Map(),
    events = [],
    context = new AsyncLocalStorage();
  const keys = {
    encryption: randomBytes(32),
    lookup: randomBytes(32),
    cookie: randomBytes(32).toString("hex"),
    signing: [],
  };
  const dir = join(root, "state");
  mkdirSync(dir, { mode: 0o700 });
  let generation = "synthetic-generation";
  const store = new Store(dir, keys);

  const families = new RefreshFamilies(store, () => generation);
  const BaseAdapter = hostedAdapter(store, families);
  let failSave = false,
    failFinalize = false,
    beforeFinalize;
  class Adapter extends BaseAdapter {
    constructor(model) {
      super(model);
      this.model = model;
    }
    async upsert(id, payload, expiresIn) {
      events.push(`${this.model}:save`);
      if (failSave && this.model === "RefreshToken")
        throw Error("synthetic persistence failure");
      await super.upsert(id, payload, expiresIn);
      rows.set(`${this.model}:${id}`, structuredClone(payload));
    }
    async find(id) {
      return super.find(id);
    }
    async findByUid(uid) {
      return super.findByUid(uid);
    }
    async destroy(id) {
      await super.destroy(id);
      rows.delete(`${this.model}:${id}`);
    }
    async consume(id) {
      const v = rows.get(`${this.model}:${id}`);
      if (!v || v.consumed) throw Error("already consumed");
      await super.consume(id);
      v.consumed = Math.floor(Date.now() / 1000);
      events.push(`${this.model}:consume`);
    }
    async revokeByGrantId(id) {
      families.revoke(id);
      await super.revokeByGrantId(id);
      for (const [k, v] of rows) if (v.grantId === id) rows.delete(k);
    }
  }
  const provider = new Provider(origin, {
    ...hostedPolicy(resource),
    adapter: Adapter,
    clients: ["native", "web"].map((id) => ({
      client_id: id,
      application_type: id === "native" ? "native" : "web",
      redirect_uris: [
        id === "native"
          ? "http://127.0.0.1:9876/callback"
          : "https://client.example/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        id === "native" ? "none" : "client_secret_post",
      ...(id === "web"
        ? { client_secret: "synthetic-client-secret-for-engine-probe" }
        : {}),
    })),
    jwks: {
      keys: [
        {
          ...(await exportJWK(signing.privateKey)),
          kid: "synthetic",
          use: "sig",
          alg: "RS256",
        },
      ],
    },
    cookies: {
      keys: [randomBytes(32).toString("hex")],
      long: { secure: true },
      short: { secure: true },
    },
    routes: { authorization: "/auth", token: "/token", jwks: "/jwks" },
    findAccount: async (ctx, id) => {
      if (id !== "synthetic-owner") throw Error("wrong owner");
      const source =
        ctx.oidc.entities.RefreshToken ?? ctx.oidc.entities.AuthorizationCode;
      if (ctx.path === "/token" && source) {
        if (ctx.oidc.client.clientId !== source.clientId)
          throw Error("wrong client");
        const op = context.getStore();
        op.family = source.grantId;
        events.push("authenticated-family");
        op.reservation = families.reserve(
          op.family,
          ctx.oidc.client.clientId,
          id,
          !ctx.oidc.entities.RefreshToken,
          !!ctx.oidc.entities.RefreshToken?.consumed,
        );
      }
      return { accountId: id, claims: async () => ({ sub: id }) };
    },
    loadExistingGrant: async (ctx) =>
      provider.Grant.find(ctx.oidc.result?.consent?.grantId),
    extraTokenClaims: async (_ctx, token) => ({ grant_id: token.grantId }),
    renderError: async (ctx) => {
      ctx.body = { error: "rejected" };
      ctx.status = 400;
    },
  });
  provider.on("server_error", () => {});
  provider.use(async (ctx, next) =>
    context.run({}, async () => {
      const op = context.getStore();
      await next();
      // The stock engine rejects an expired member before findAccount. Its
      // invalid_grant response follows client authentication; invalid_client
      // must never be treated as evidence of authenticated token possession.
      if (
        ctx.path === "/token" &&
        ctx.body?.error === "invalid_grant" &&
        ctx.oidc.params?.grant_type === "refresh_token"
      ) {
        const source = await provider.RefreshToken.find(
          ctx.oidc.params.refresh_token,
          { ignoreExpiration: true },
        );
        if (source?.consumed && source.clientId === ctx.oidc.client?.clientId)
          families.revoke(source.grantId);
      }
      if (op.family) {
        if (beforeFinalize) await beforeFinalize(op.family);
        if (
          ctx.status !== 200 ||
          !ctx.body?.access_token ||
          failFinalize ||
          families.get(op.family)?.status !== "rotating"
        ) {
          families.revoke(op.family);
          ctx.status = 400;
          ctx.body = { error: "invalid_grant" };
        } else {
          try {
            families.finish(op.reservation);
            events.push("finalized");
          } catch {
            ctx.status = 400;
            ctx.body = { error: "invalid_grant" };
          }
        }
      }
    }),
  );
  dispatch = async (req, res) => {
    try {
      const u = new URL(req.url, origin);
      if (u.pathname === "/auth")
        req.url = `/auth?${requireConsent(u.searchParams)}`;
      if (u.pathname.startsWith("/interaction/")) {
        const detail = await provider.interactionDetails(req, res);
        if (req.method === "GET") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ uid: detail.uid, scope: detail.params.scope }),
          );
          return;
        }
        if (
          req.headers.origin !== origin ||
          req.headers["x-synthetic-decision"] !== detail.uid
        )
          throw Error("decision missing");
        const grant = new provider.Grant({
          accountId: "synthetic-owner",
          clientId: detail.params.client_id,
        });
        grant.addResourceScope(resource, "ynab:read");
        if (detail.params.scope.split(" ").includes("offline_access"))
          grant.addOIDCScope("offline_access");
        const grantId = await grant.save();
        families.create(
          grantId,
          detail.params.client_id,
          "synthetic-owner",
          resource,
        );
        await provider.interactionFinished(
          req,
          res,
          { login: { accountId: "synthetic-owner" }, consent: { grantId } },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      await provider.callback()(req, res);
    } catch {
      res.statusCode = 400;
      res.end('{"error":"rejected"}');
    }
  };
  class Browser {
    cookies = new Map();
    async fetch(url, { method = "GET", body, headers = {} } = {}) {
      const u = new URL(url, origin);
      if (u.origin !== origin) throw Error("test network boundary");
      const cookie = [...this.cookies.values()]
        .filter((v) => u.pathname.startsWith(v.path))
        .map((v) => v.value)
        .join("; ");
      return new Promise((resolve, reject) => {
        const req = request(
          u,
          { ca: cert, method, headers: { cookie, ...headers } },
          (res) => {
            for (const raw of res.headers["set-cookie"] ?? []) {
              const path = raw.match(/; path=([^;]+)/i)?.[1] ?? "/";
              const value = raw.split(";")[0];
              this.cookies.set(`${path}:${value.split("=")[0]}`, {
                path,
                value,
              });
            }
            let text = "";
            res.on("data", (b) => {
              text += b;
              if (text.length > 65536) req.destroy();
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text,
                json: () => JSON.parse(text),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    }
  }
  async function authorize({
    client = "native",
    scope = "ynab:read offline_access",
    prompt,
  } = {}) {
    const browser = new Browser(),
      verifier = randomBytes(32).toString("base64url");
    const callback =
      client === "native"
        ? "http://127.0.0.1:9876/callback"
        : "https://client.example/callback";
    const query = new URLSearchParams({
      client_id: client,
      redirect_uri: callback,
      response_type: "code",
      resource,
      scope,
      state: "synthetic-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    if (prompt) query.set("prompt", prompt);
    let r = await browser.fetch(`/auth?${query}`),
      consents = 0;
    for (let i = 0; i < 8 && r.headers.location; i++) {
      const u = new URL(r.headers.location, origin);
      if (u.href.startsWith(callback))
        return {
          browser,
          verifier,
          callback,
          params: u.searchParams,
          client,
          consents,
        };
      r = await browser.fetch(u);
      if (u.pathname.startsWith("/interaction/") && r.status === 200) {
        const d = r.json();
        consents++;
        r = await browser.fetch(u, {
          method: "POST",
          headers: { origin, "x-synthetic-decision": d.uid },
        });
      }
    }
    return { status: r.status, body: r.text, consents };
  }
  async function token(values) {
    const body = new URLSearchParams(values).toString();
    const r = await new Browser().fetch("/token", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    return { status: r.status, body: r.json() };
  }
  async function exchange(a) {
    return token({
      grant_type: "authorization_code",
      client_id: a.client,
      code: a.params.get("code"),
      code_verifier: a.verifier,
      redirect_uri: a.callback,
      resource,
      ...(a.client === "web"
        ? { client_secret: "synthetic-client-secret-for-engine-probe" }
        : {}),
    });
  }
  t.after(async () => {
    await beforeCleanup();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    beforeCleanup: (fn) => {
      beforeCleanup = fn;
    },
    provider,
    setHandler: (handler) => {
      dispatch = handler;
    },
    root,
    rows,
    families,
    store,
    dir,
    keys,
    events,
    origin,
    resource,
    authorize,
    exchange,
    token,
    Browser,
    faultSave: () => {
      failSave = true;
    },
    faultFinalize: () => {
      failFinalize = true;
    },
    beforeFinalize: (fn) => {
      beforeFinalize = fn;
    },
    disconnect: () => {
      generation = undefined;
    },
  };
}
