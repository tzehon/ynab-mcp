import { lstatSync, realpathSync } from "node:fs";
import { connect } from "node:net";
const directory = "/run/ynab-mcp",
  path = `${directory}/admin.sock`;
try {
  const command = process.argv[2];
  if (
    !["status", "candidate", "confirm"].includes(command) ||
    process.argv.length !== 3
  )
    throw Error();
  if (realpathSync(directory) !== directory) throw Error();
  const dir = lstatSync(directory),
    socket = lstatSync(path);
  if (
    !dir.isDirectory() ||
    dir.mode & 0o077 ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.mode & 0o177 ||
    dir.uid !== process.getuid() ||
    socket.uid !== process.getuid()
  )
    throw Error();
  let owner;
  if (command === "confirm") {
    let data = "";
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > 64) throw Error();
    }
    owner = data.trim();
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner))
      throw Error();
  }
  const client = connect(path);
  client.setTimeout(3000, () => client.destroy(Error()));
  client.on("error", () => {
    console.error("ADMIN_REJECTED");
    process.exitCode = 1;
  });
  let reply = "";
  client.on("data", (chunk) => {
    reply += chunk;
    if (reply.length > 1024) client.destroy(Error());
  });
  client.on("end", () => {
    try {
      const value = JSON.parse(reply);
      if (value.error) throw Error();
      console.log(JSON.stringify(value));
    } catch {
      console.error("ADMIN_REJECTED");
      process.exitCode = 1;
    }
  });
  client.on("connect", () =>
    client.end(`${JSON.stringify({ command, ...(owner ? { owner } : {}) })}\n`),
  );
} catch {
  console.error("ADMIN_REJECTED");
  process.exitCode = 1;
}
