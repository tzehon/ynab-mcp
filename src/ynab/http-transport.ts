import { setImmediate as yieldTurn } from "node:timers/promises";
import { ToolError } from "../tools/errors.js";
import { MAX_BODY } from "./contracts.js";
import { httpRequest, mappedAllowlist } from "./http-request.js";
import type { MockTransport } from "./transport.js";

export type HttpTransportOptions = Readonly<{
  allowedMappedIds: readonly string[];
  accessToken: (signal: AbortSignal) => Promise<string>;
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
}>;

const timeout = () => new ToolError("UPSTREAM_TIMEOUT");
function check(signal: AbortSignal) {
  if (signal.aborted) throw timeout();
}
function discard(work: () => unknown) {
  try {
    void Promise.resolve(work()).catch(() => {});
  } catch {}
}
function dispose(response: Response) {
  discard(() => response.body?.cancel());
}

// Handles late completion as well as abort; no abandoned rejection/listener.
function cancellable<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(timeout());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => {
        check(signal);
        return work();
      })
      .then(
        (value) => {
          if (settled) {
            if (late) discard(() => late(value));
            return;
          }
          settled = true;
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            if (late) discard(() => late(value));
            reject(timeout());
          } else resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

/** Internal adapter: callers supply CallLimits' one total deadline/admission. */
export function createHttpTransport(
  options: HttpTransportOptions,
): MockTransport {
  let allowed: ReadonlySet<string>;
  let accessToken: HttpTransportOptions["accessToken"];
  let fetcher: HttpTransportOptions["fetcher"];
  try {
    if (!options) throw new Error();
    accessToken = options.accessToken;
    fetcher = options.fetcher;
    if (typeof accessToken !== "function" || typeof fetcher !== "function")
      throw new Error();
    allowed = mappedAllowlist(options.allowedMappedIds);
  } catch {
    throw new ToolError("INVALID_ARGUMENTS");
  }
  return async (request, signal) => {
    if (!(signal instanceof AbortSignal))
      throw new ToolError("INVALID_ARGUMENTS");
    check(signal);
    const url = httpRequest(request, allowed);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const child = controller.signal;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      let token: string;
      try {
        token = await cancellable(() => accessToken(child), child);
        check(child);
        if (
          typeof token !== "string" ||
          token.length < 1 ||
          token.length > 8192 ||
          token.match(/^[A-Za-z0-9._~+/-]+=*$/)?.[0] !== token
        )
          throw new Error();
      } catch {
        check(child);
        throw new ToolError("UPSTREAM_UNAUTHORIZED");
      }
      try {
        response = await cancellable(
          () =>
            fetcher(url, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
              },
              redirect: "manual",
              credentials: "omit",
              signal: child,
            }),
          child,
          dispose,
        );
      } catch {
        check(child);
        throw new ToolError("UPSTREAM_FAILURE");
      }
      check(child);
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599 ||
        typeof response.redirected !== "boolean" ||
        response.redirected
      )
        throw new ToolError("UPSTREAM_INVALID_RESPONSE");
      const status = response.status;
      const chunks: Uint8Array[] = [];
      if (status === 200) {
        try {
          const media = response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (
            media !== "application/json" ||
            !response.body ||
            response.body.locked
          )
            throw new Error();
          reader = response.body.getReader();
        } catch {
          throw new ToolError("UPSTREAM_INVALID_RESPONSE");
        }
        let size = 0,
          reads = 0;
        while (true) {
          // Let the caller's existing deadline fire even for immediately ready
          // synthetic streams; empty chunks must not grow a retained array.
          if (++reads % 64 === 0) await yieldTurn();
          check(child);
          let item: ReadableStreamReadResult<Uint8Array>;
          try {
            const active = reader;
            item = await cancellable(() => active.read(), child);
          } catch {
            check(child);
            throw new ToolError("UPSTREAM_FAILURE");
          }
          check(child);
          if (!item || typeof item.done !== "boolean")
            throw new ToolError("UPSTREAM_INVALID_RESPONSE");
          if (item.done) {
            complete = true;
            break;
          }
          if (!(item.value instanceof Uint8Array))
            throw new ToolError("UPSTREAM_INVALID_RESPONSE");
          if (item.value.byteLength > MAX_BODY - size)
            throw new ToolError("UPSTREAM_RESPONSE_TOO_LARGE");
          size += item.value.byteLength;
          if (item.value.byteLength) chunks.push(item.value.slice());
        }
      }
      check(child);
      return Object.freeze({
        status,
        headers: Object.freeze({}),
        body: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      });
    } catch (error) {
      check(child);
      if (error instanceof ToolError) throw error;
      throw new ToolError("UPSTREAM_INVALID_RESPONSE");
    } finally {
      signal.removeEventListener("abort", abort);
      if (reader) {
        if (!complete) discard(() => reader?.cancel());
        discard(() => reader?.releaseLock());
      } else if (response) dispose(response);
      controller.abort();
    }
  };
}
