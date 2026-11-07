import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Config } from "./config.js";
import { createFixtureHandler } from "./mcp.js";
import { MockYnabClient } from "./ynab/client.js";
import { fixtureTransport } from "./fixtures/ynab.js";
import type { MockTransport } from "./ynab/transport.js";
import { canonicalError } from "./tools/errors.js";
import { operationalLog } from "./errors.js";

function reply(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    Connection: "close",
  });
  res.end(JSON.stringify({ error: code }));
}
// Preserve required correlation IDs/codes, but never echo SDK validation text or input.
export function sanitizeProtocolResponse(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const body = value as Record<string, unknown>;
  if (body.error && typeof body.error === "object") {
    const error = body.error as Record<string, unknown>;
    return {
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: {
        code: typeof error.code === "number" ? error.code : -32603,
        message: "MCP_REQUEST_REJECTED",
      },
    };
  }
  if (body.result && typeof body.result === "object") {
    const result = body.result as Record<string, unknown>;
    if (result.isError === true) {
      const known = canonicalError(result);
      return {
        ...body,
        result: {
          ...(result.resultType === "complete"
            ? { resultType: "complete" }
            : {}),
          ...(known ?? {
            isError: true,
            content: [{ type: "text", text: "TOOL_REQUEST_REJECTED" }],
          }),
        },
      };
    }
  }
  return value;
}
export function createFixtureHttp(
  config: Config,
  transport: MockTransport = fixtureTransport,
) {
  const client = new MockYnabClient(config, transport);
  const handler = createFixtureHandler(config, client);
  const guardedFetch = {
    async fetch(request: Request) {
      // This slice has no subscription streams, even when the SDK supports them.
      let method: unknown;
      try {
        method = (await request.clone().json()).method;
      } catch {
        /* SDK reports malformed JSON. */
      }
      if (method === "subscriptions/listen")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32601, message: "METHOD_NOT_SUPPORTED" },
          },
          { status: 400 },
        );
      const response = await handler.fetch(request);
      const contentType = response.headers.get("content-type") ?? "";
      let body: unknown;
      if (contentType.includes("application/json"))
        body = await response.json();
      else if (contentType.includes("text/event-stream")) {
        // SDK 2.4's stateless legacy leg emits a finite single-result SSE event
        // despite responseMode=json. Normalize that terminal event to JSON.
        const data = (await response.text())
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data: "));
        if (data.length !== 1 || !data[0])
          throw new Error("UNEXPECTED_PROTOCOL_RESPONSE");
        body = JSON.parse(data[0].slice(6));
      } else return response;
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/json");
      headers.delete("content-length");
      return new Response(JSON.stringify(sanitizeProtocolResponse(body)), {
        status: response.status,
        headers,
      });
    },
  };
  const adapter = toNodeHandler(guardedFetch, {
    maxRequestBodySize: 65536,
    onerror: () => operationalLog("HTTP_FAILED"),
  });
  const sockets = new Map<Socket, ReturnType<typeof setTimeout>>();
  const server = createServer(
    {
      headersTimeout: 10000,
      requestTimeout: 10000,
      connectionsCheckingInterval: 100,
    },
    (req, res) => {
      res.setHeader("Connection", "close");
      const address = server.address();
      const authority =
        typeof address === "object" && address
          ? `127.0.0.1:${address.port}`
          : "";
      // Reject duplicates as well as lookalikes; forwarded headers never establish authority.
      const count = (name: string) =>
        req.rawHeaders.filter(
          (_, i) => i % 2 === 0 && req.rawHeaders[i]?.toLowerCase() === name,
        ).length;
      if (
        count("host") !== 1 ||
        req.headers.host !== authority ||
        count("origin") > 1 ||
        (req.headers.origin !== undefined &&
          req.headers.origin !== `http://${authority}`)
      ) {
        reply(res, 403, "LOCAL_ORIGIN_REQUIRED");
        return;
      }
      if (req.url !== "/healthz" && req.url !== "/mcp") {
        reply(res, 404, "NOT_FOUND");
        return;
      }
      if (req.url === "/healthz") {
        if (req.method !== "GET") {
          reply(res, 405, "METHOD_NOT_ALLOWED");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", data_mode: "fixtures" }));
        return;
      }
      if (req.method !== "POST") {
        reply(res, 405, "METHOD_NOT_ALLOWED");
        return;
      }
      if (Number(req.headers["content-length"]) > 65536) {
        reply(res, 413, "BODY_TOO_LARGE");
        return;
      }
      void adapter(req, res).catch(() => {
        if (!res.headersSent) reply(res, 500, "HTTP_FAILED");
        else res.destroy();
      });
    },
  );
  // A total connection deadline also bounds slowly trickled/incomplete headers.
  // Each response closes its connection; the SDK is stateless and needs no keepalive.
  server.on("connection", (socket) => {
    const timer = setTimeout(() => socket.destroy(), 10000);
    timer.unref();
    sockets.set(socket, timer);
    socket.on("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  return {
    server,
    async close() {
      client.close();
      const closed = server.listening
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : Promise.resolve();
      for (const [socket, timer] of sockets) {
        clearTimeout(timer);
        socket.destroy();
      }
      await Promise.all([handler.close(), closed]);
    },
  };
}
