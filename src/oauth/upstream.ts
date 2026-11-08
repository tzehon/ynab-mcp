import * as oauth from "oauth4webapi";
import type { OAuthConfig } from "./config.js";
import { fail } from "./crypto.js";
export type Tokens = { access: string; refresh: string; expires: number };
export class Upstream {
  private active = 0;
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    private config: OAuthConfig,
    private fetcher: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {}
  private metadata() {
    return {
      issuer: this.config.upstream,
      authorization_endpoint: `${this.config.upstream}/oauth/authorize`,
      token_endpoint: `${this.config.upstream}/oauth/token`,
    };
  }
  private client() {
    return { client_id: "synthetic-ynab-client" };
  }
  private request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (
      this.closed ||
      this.active >= 4 ||
      ![
        `${this.config.upstream}/oauth/token`,
        `${this.config.upstream}/v1/user`,
      ].includes(url)
    )
      fail();
    this.active++;
    const c = new AbortController();
    this.controllers.add(c);
    const timer = setTimeout(() => c.abort(), 3000);
    try {
      const response = await this.fetcher(input, {
        ...init,
        redirect: "manual",
        signal: c.signal,
      });
      if (response.status >= 300 && response.status < 400) fail();
      if (!response.headers.get("content-type")?.startsWith("application/json"))
        fail();
      const reader = response.body?.getReader();
      if (!reader) fail();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
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
      clearTimeout(timer);
      this.controllers.delete(c);
      this.active--;
    }
  };
  private options() {
    return {
      [oauth.allowInsecureRequests]: true,
      [oauth.customFetch]: this.request,
    };
  }
  private tokens(
    result: oauth.TokenEndpointResponse,
    previous?: string,
  ): Tokens {
    if (
      typeof result.access_token !== "string" ||
      !result.access_token ||
      result.access_token.length > 8192 ||
      typeof result.expires_in !== "number" ||
      !Number.isSafeInteger(result.expires_in) ||
      result.expires_in <= 0 ||
      result.expires_in > 86400 * 30 ||
      (result.scope !== undefined && result.scope !== "read-only")
    )
      fail();
    const refresh = result.refresh_token ?? previous;
    if (typeof refresh !== "string" || !refresh || refresh.length > 8192)
      fail();
    return {
      access: result.access_token,
      refresh: refresh as string,
      expires: this.now() + result.expires_in * 1000,
    };
  }
  async exchange(params: URLSearchParams, state: string, verifier: string) {
    const valid = oauth.validateAuthResponse(
      this.metadata(),
      this.client(),
      params,
      state,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      this.metadata(),
      this.client(),
      oauth.ClientSecretPost(this.config.upstreamSecret),
      valid,
      `${this.config.origin}/connect/ynab/callback`,
      verifier,
      this.options(),
    );
    const tokens = this.tokens(
      await oauth.processAuthorizationCodeResponse(
        this.metadata(),
        this.client(),
        response,
      ),
    );
    const user = await this.request(`${this.config.upstream}/v1/user`, {
      headers: { authorization: `Bearer ${tokens.access}` },
    });
    if (user.status !== 200) fail();
    const body = await user.json();
    if (body?.data?.user?.id !== this.config.owner) fail();
    return tokens;
  }
  async refresh(previous: Tokens) {
    const response = await oauth.refreshTokenGrantRequest(
      this.metadata(),
      this.client(),
      oauth.ClientSecretPost(this.config.upstreamSecret),
      previous.refresh,
      this.options(),
    );
    return this.tokens(
      await oauth.processRefreshTokenResponse(
        this.metadata(),
        this.client(),
        response,
      ),
      previous.refresh,
    );
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
  }
}
