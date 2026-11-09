import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Enrollment } from "./enrollment.js";
import { privatePath } from "./keys.js";

export async function hostedAdmin(dir: string, enrollment: Enrollment) {
  privatePath(dir, true);
  const path = join(dir, "admin.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {});
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(3000, () => socket.destroy());
    let data = "",
      finished = false;
    socket.on("data", (chunk) => {
      if (finished) return;
      data += chunk;
      if (Buffer.byteLength(data) > 1024) {
        socket.destroy();
        return;
      }
      if (!data.endsWith("\n")) return;
      finished = true;
      try {
        const input = JSON.parse(data);
        let value: unknown;
        if (input.command === "status" && Object.keys(input).length === 1)
          value = { phase: enrollment.status() };
        else if (
          input.command === "candidate" &&
          Object.keys(input).length === 1
        )
          value = { candidate: enrollment.inspectCandidate() };
        else if (
          input.command === "confirm" &&
          Object.keys(input).length === 2 &&
          typeof input.owner === "string"
        ) {
          enrollment.confirm(input.owner);
          value = { confirmed: true };
        } else throw Error();
        socket.end(`${JSON.stringify(value)}\n`);
      } catch {
        socket.end('{"error":"ADMIN_REJECTED"}\n');
      }
    });
  });
  const old = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        chmodSync(path, 0o600);
        resolve();
      });
    });
  } finally {
    process.umask(old);
  }
  return {
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
