import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

// Trusted-code test instrumentation, not a malicious-dependency sandbox.
export function guardLoopback(t, ports) {
  const connect = net.Socket.prototype.connect;
  const lookup = dns.lookup;
  const allowed = new Set(ports);
  let denied = 0;
  const deny = () => {
    denied++;
    throw new Error("TEST_NETWORK_DENIED");
  };
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options =
      first && typeof first === "object"
        ? first
        : { port: first, host: args[1] };
    if (
      options.host !== "127.0.0.1" ||
      !allowed.has(Number(options.port)) ||
      options.path
    )
      return deny();
    return connect.apply(this, args);
  };
  dns.lookup = (host, ...args) =>
    host === "127.0.0.1" ? lookup(host, ...args) : deny();
  syncBuiltinESMExports();
  t.after(() => {
    net.Socket.prototype.connect = connect;
    dns.lookup = lookup;
    syncBuiltinESMExports();
  });
  return () => denied;
}
