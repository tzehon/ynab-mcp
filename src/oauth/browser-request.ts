import type { IncomingMessage } from "node:http";

// A no-referrer HTML form navigation uses an opaque Origin in Chromium.
// Fetch Metadata still identifies the initiating page; require the complete
// browser-navigation tuple only on cookie/CSRF-bound interaction forms.
// Other callers must continue sending the exact local origin.
export function sameOriginForm(req: IncomingMessage, enrollment = false) {
  return (
    req.method === "POST" &&
    req.headers.origin === "null" &&
    req.headers["sec-fetch-site"] === "same-origin" &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    req.headers["sec-fetch-dest"] === "document" &&
    ((enrollment && req.url === "/enroll") ||
      /^\/(?:interaction\/[A-Za-z0-9_-]+|connection\/(?:refresh|disconnect|plans))$/.test(
        req.url ?? "",
      ))
  );
}
