import * as oauth from "oauth4webapi";
import { fail } from "./crypto.js";
import type { Tokens } from "./upstream.js";

const TOKEN = "https://app.ynab.com/oauth/token";
const USER = "https://api.ynab.com/v1/user";
const metadata = {
  issuer: "https://app.ynab.com",
  authorization_endpoint: "https://app.ynab.com/oauth/authorize",
  token_endpoint: TOKEN,
};

// Production construction supplies native fetch. The injected fetcher is a
// factory seam for synthetic HTTPS tests, never an environment-selected URL.
export class HostedUpstream {
  private active = 0;
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    private clientId: string,
    private secret: string,
    private callback: string,
    private fetcher: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {}
  readonly authorization = metadata.authorization_endpoint;
  private request: typeof fetch = async (input, init) => {
    const url = String(input),
      method = init?.method?.toUpperCase() ?? "GET";
    if (
      this.closed ||
      this.active >= 4 ||
      !(
        (url === TOKEN && method === "POST") ||
        (url === USER && method === "GET")
      )
    )
      fail();
    const c = new AbortController();
    this.controllers.add(c);
    this.active++;
    const timeout = setTimeout(() => c.abort(), 3000);
    try {
      const response = await this.fetcher(input, {
        ...init,
        redirect: "manual",
        signal: c.signal,
      });
      if (
        (response.status >= 300 && response.status < 400) ||
        !response.headers.get("content-type")?.startsWith("application/json")
      )
        fail();
      const reader = response.body?.getReader();
      if (!reader) fail();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > 65536) fail();
          chunks.push(r.value);
        }
      } finally {
        await reader.cancel();
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return fail();
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(c);
      this.active--;
    }
  };
  private parse(
    result: oauth.TokenEndpointResponse,
    previous?: string,
  ): Tokens {
    const refresh = result.refresh_token ?? previous;
    if (
      typeof result.access_token !== "string" ||
      !result.access_token ||
      result.access_token.length > 8192 ||
      typeof refresh !== "string" ||
      !refresh ||
      refresh.length > 8192 ||
      result.token_type.toLowerCase() !== "bearer" ||
      !Number.isSafeInteger(result.expires_in) ||
      (result.expires_in as number) <= 0 ||
      (result.expires_in as number) > 86400 * 30 ||
      (result.scope !== undefined && result.scope !== "read-only")
    )
      fail();
    return {
      access: result.access_token,
      refresh: refresh as string,
      expires: this.now() + (result.expires_in as number) * 1000,
    };
  }
  async exchange(params: URLSearchParams, state: string, verifier: string) {
    const client = { client_id: this.clientId };
    const valid = oauth.validateAuthResponse(metadata, client, params, state);
    const response = await oauth.authorizationCodeGrantRequest(
      metadata,
      client,
      oauth.ClientSecretPost(this.secret),
      valid,
      this.callback,
      verifier,
      { [oauth.customFetch]: this.request },
    );
    const tokens = this.parse(
      await oauth.processAuthorizationCodeResponse(metadata, client, response),
    );
    const user = await this.request(USER, {
      method: "GET",
      headers: { authorization: `Bearer ${tokens.access}` },
    });
    if (user.status !== 200) fail();
    const value = await user.json(),
      owner = value?.data?.user?.id;
    if (
      typeof owner !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner)
    )
      fail();
    return { owner: owner as string, tokens };
  }
  async refresh(previous: Tokens) {
    const client = { client_id: this.clientId };
    const response = await oauth.refreshTokenGrantRequest(
      metadata,
      client,
      oauth.ClientSecretPost(this.secret),
      previous.refresh,
      { [oauth.customFetch]: this.request },
    );
    return this.parse(
      await oauth.processRefreshTokenResponse(metadata, client, response),
      previous.refresh,
    );
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
  }
}
