/**
 * Command line client for the gRPC API (port of `dedicated_server/src/bin/cli.rs`).
 *
 * Usage:
 *   bun run scripts/api-cli.ts send-invite -u <user> -p <password> [--url host:port] <target ubi id>
 *   bun run scripts/api-cli.ts get-event -u <user> -p <password> [--url host:port]
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    username: { type: "string", short: "u" },
    password: { type: "string", short: "p" },
    url: { type: "string", default: "127.0.0.1:50051" },
  },
});
const [command, target] = positionals;
if (!values.username || !values.password || !["send-invite", "get-event"].includes(command) || (command === "send-invite" && !target)) {
  console.error("usage: api-cli.ts (send-invite <target> | get-event) -u <username> -p <password> [--url host:port]");
  process.exit(2);
}

const definition = protoLoader.loadSync(["users.proto", "friends.proto", "misc.proto"], {
  includeDirs: [join(import.meta.dir, "..", "proto")],
  keepCase: true,
  longs: Number,
  defaults: true,
});
const pkg = grpc.loadPackageDefinition(definition) as any;
const credentials = grpc.credentials.createInsecure();

function call<T>(client: any, method: string, request: object, metadata = new grpc.Metadata()): Promise<T> {
  return new Promise((resolve, reject) =>
    client[method](request, metadata, (error: grpc.ServiceError | null, response: T) => (error ? reject(error) : resolve(response))),
  );
}

try {
  const login = await call<{ token: string }>(new pkg.users.Users(values.url, credentials), "Login", {
    username: values.username,
    password: values.password,
  });
  const metadata = new grpc.Metadata();
  metadata.set("authorization", login.token);
  if (command === "send-invite") {
    await call(new pkg.friends.Friends(values.url, credentials), "Invite", { id: target }, metadata);
    console.log(`Invited ${target}`);
  } else {
    console.log(Bun.inspect(await call(new pkg.misc.Misc(values.url, credentials), "Event", {}, metadata), { depth: 5 }));
  }
  process.exit(0);
} catch (e) {
  const error = e as grpc.ServiceError;
  console.error(`${grpc.status[error.code] ?? "error"}: ${error.details ?? error.message}`);
  process.exit(1);
}
