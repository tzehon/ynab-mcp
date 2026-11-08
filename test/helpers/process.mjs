import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixtureEnv } from "./server.mjs";
import { portEnv } from './auth.mjs';
export { unusedPort } from './auth.mjs';
export function launch(port, extra = {}, args = ["dist/main.js"]) {
  const env = {
    PATH: process.env.PATH,
    ...fixtureEnv,
    ...portEnv(port),
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const exited = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
  }));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("START_TIMEOUT"));
    }, 8000);
    const check = () => {
      if (output.includes('"code":"LISTENING"')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stderr.on("data", check);
    exited.then(() => {
      clearTimeout(timer);
      if (!output.includes('"code":"LISTENING"'))
        reject(new Error("START_FAILED"));
    });
  });
  ready.catch(() => {});
  return {
    child,
    ready,
    exited,
    output: () => output,
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
      return exited;
    },
  };
}
