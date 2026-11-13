import type { Config } from "./config.js";
import { Admission } from "./http/admission.js";
import { hostedBoundary } from "./http/hosted-boundary.js";
import { hostedPublicPage } from "./http/hosted-pages.js";
import { createFixtureHttp } from "./http.js";
import { sameOriginForm } from "./oauth/browser-request.js";
import { fail } from "./oauth/crypto.js";
import { hostedService } from "./oauth/hosted-service.js";
import { securityHeaders } from "./oauth/interactions.js";

// Only main.ts calls this factory in production, without injection. Tests use
// the same pipeline with an explicit injected HTTPS transport, never env flags.
export async function createHostedHttp(
  config: Config,
  fetcher: typeof fetch = fetch,
) {
  const hosted = config.hosted;
  if (!hosted) fail();
  const service = await hostedService(hosted, fetcher, config),
    admission = new Admission();
  try {
    const app = createFixtureHttp(config, undefined, undefined, undefined, {
      oauth: service,
      live: service.live,
      before: (req, res) => {
        securityHeaders(res);
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
        try {
          service.ready();
        } catch {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end('{"error":"temporarily_unavailable"}');
          return false;
        }
        try {
          const path = hostedBoundary(req, hosted.origin);
          if (
            req.headers.origin !== undefined &&
            req.headers.origin !== hosted.origin &&
            !sameOriginForm(req, true)
          )
            fail();
          const slot = admission.enter(path === "/enroll" ? "/auth" : path);
          if (!slot) {
            res.writeHead(429, { "Retry-After": "60" });
            res.end('{"error":"temporarily_unavailable"}');
            return false;
          }
          res.once("finish", slot.release);
          res.once("close", slot.release);
          if (hostedPublicPage(req, res, path)) return false;
          if (service.enrollment && path === "/mcp") {
            res.writeHead(403);
            res.end('{"error":"enrollment_required"}');
            return false;
          }
          return true;
        } catch {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end('{"error":"HTTP_REJECTED"}');
          return false;
        }
      },
    });
    return {
      server: app.server,
      async close() {
        admission.close();
        await app.close();
      },
    };
  } catch (e) {
    await service.close();
    throw e;
  }
}
