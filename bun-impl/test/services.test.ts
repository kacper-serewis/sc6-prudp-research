/**
 * The HTTP services and the gRPC API, started in-process.
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { udp } from "bun";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { base32, startApiServer } from "../src/api/server";
import { serveContent, serveFiles } from "../src/http/simple-http";
import type { SocketAddress } from "../src/quazal/context";
import { Storage } from "../src/storage/storage";
import { testLogger } from "./harness";

function rawHttp(address: SocketAddress, request: string) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(address.port, address.host, () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("error", reject);
  });
}

const addressOf = (server: Server) => ({ host: "127.0.0.1", port: (server.address() as AddressInfo).port });

describe("HTTP services", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  test("the config service answers every request with the content", async () => {
    const server = await serveContent(testLogger, { host: "127.0.0.1", port: 0 }, '[{"Name":"x"}]');
    servers.push(server);
    const response = await rawHttp(addressOf(server), "GET /anything HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(response).toBe(
      'HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 14\r\n\r\n[{"Name":"x"}]',
    );
  });

  test("request lines are not buffered without limit", async () => {
    const config = await serveContent(testLogger, { host: "127.0.0.1", port: 0 }, "content");
    const files = await serveFiles(testLogger, { host: "127.0.0.1", port: 0 }, new Map());
    servers.push(config, files);
    const endless = `GET /${"a".repeat(20_000)}`; // no line break
    expect(await rawHttp(addressOf(config), endless)).toStartWith("HTTP/1.0 200 OK");
    expect(await rawHttp(addressOf(files), endless)).toBe("HTTP/1.0 400 Bad Request\r\n\r\n");
  });

  test("the content service serves configured files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc6-content-"));
    writeFileSync(join(dir, "mp.ini"), "[Section]\nKey=1\n");
    const server = await serveFiles(
      testLogger,
      { host: "127.0.0.1", port: 0 },
      new Map([
        ["/mp_balancing.ini", join(dir, "mp.ini")],
        ["/gone", join(dir, "missing.ini")],
      ]),
    );
    servers.push(server);
    const address = addressOf(server);
    expect(await rawHttp(address, "GET /mp_balancing.ini HTTP/1.1\r\n\r\n")).toBe(
      "HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 16\r\n\r\n[Section]\nKey=1\n",
    );
    expect(await rawHttp(address, "GET /nope HTTP/1.1\r\n\r\n")).toBe("HTTP/1.0 404 Not Found\r\n\r\n");
    expect(await rawHttp(address, "PUT /mp_balancing.ini HTTP/1.1\r\n\r\n")).toBe("HTTP/1.0 405 Method Not Allowed\r\n\r\n");
    expect(await rawHttp(address, "GET /mp_balancing.ini HTTP/1.0\r\n\r\n")).toBe("HTTP/1.0 400 Bad Request\r\n\r\n");
    expect(await rawHttp(address, "GET /gone HTTP/1.1\r\n\r\n")).toBe("HTTP/1.0 500 Internal Server Error\r\n\r\n");
  });
});

describe("gRPC API", () => {
  let storage: Storage;
  let api: Awaited<ReturnType<typeof startApiServer>>;
  let adminKey = "";
  let pkg: any;
  let address = "";

  // Stands in for the launcher during `Misc.TestP2P`: answers with the challenge.
  let launcher: udp.Socket<"buffer">;

  beforeAll(async () => {
    launcher = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: {
        data(socket, data, port, host) {
          const prefix = Buffer.from("P2P Test - ");
          if (Buffer.from(data).subarray(0, prefix.length).equals(prefix)) {
            socket.send(Buffer.from(data).subarray(prefix.length), port, host);
          }
        },
      },
    });
    storage = new Storage(new Database(":memory:"), testLogger);
    api = await startApiServer({
      p2pTestPort: launcher.port,
      logger: testLogger,
      storage,
      address: { host: "127.0.0.1", port: 0 },
      debug: { markAllAsOnline: false, forceJoins: true },
      enableAdminServices: true,
      onAdminKey: (key) => (adminKey = key),
    });
    address = `127.0.0.1:${api.port}`;
    const definition = protoLoader.loadSync(["users.proto", "friends.proto", "misc.proto", "games.proto"], {
      includeDirs: [join(import.meta.dir, "..", "proto")],
      keepCase: true,
      longs: Number,
      defaults: true,
    });
    pkg = grpc.loadPackageDefinition(definition);
  });

  afterAll(() => {
    api.server.forceShutdown();
    storage.close();
    launcher.close();
  });

  type Result = { ok: true; value: any } | { ok: false; code: string; details: string };

  function call(service: string, method: string, request: object, token?: string): Promise<Result> {
    const [ns, name] = service.split(".");
    const stub = new pkg[ns][name](address, grpc.credentials.createInsecure());
    const metadata = new grpc.Metadata();
    if (token) metadata.set("authorization", token);
    return new Promise((resolve) =>
      stub[method](request, metadata, (error: grpc.ServiceError | null, value: unknown) => {
        stub.close();
        resolve(error ? { ok: false, code: grpc.status[error.code], details: error.details } : { ok: true, value });
      }),
    );
  }

  async function login(username: string, password: string) {
    const result = await call("users.Users", "Login", { username, password });
    if (!result.ok) throw new Error(result.details);
    return result.value.token as string;
  }

  test("register and login", async () => {
    expect(await call("users.Users", "Register", { username: "alice", password: "pw", ubi_id: "ALICE" })).toMatchObject({ ok: true });
    expect(await call("users.Users", "Register", { username: "alice", password: "pw", ubi_id: "OTHER" })).toEqual({
      ok: false,
      code: "ALREADY_EXISTS",
      details: "Username already taken or Ubisoft ID already registered",
    });
    expect(await call("users.Users", "Login", { username: "alice", password: "nope" })).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
      details: "Invalid login",
    });
    expect(await call("users.Users", "Login", { username: "bob", password: "x" })).toEqual({
      ok: false,
      code: "NOT_FOUND",
      details: "Unknown user",
    });
    expect(await login("alice", "pw")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  test("tokens protect the friends and misc services", async () => {
    expect(await call("friends.Friends", "List", {})).toMatchObject({ code: "UNAUTHENTICATED", details: "Missing authorization" });
    expect(await call("friends.Friends", "List", {}, "abc.def")).toMatchObject({ code: "UNAUTHENTICATED", details: "Invalid token" });
    const token = await login("sam_the_fisher", "password1234");
    const [ciphertext, nonce] = token.split(".");
    expect(await call("friends.Friends", "List", {}, `${ciphertext}x.${nonce}`)).toMatchObject({ code: "UNAUTHENTICATED" });

    const list = await call("friends.Friends", "List", {}, token);
    expect(list.ok && list.value.friends.map((f: any) => f.id).sort()).toEqual(["ABCD", "ALICE", "MYID", "SAM"]);
  });

  test("invites are delivered once through events", async () => {
    const alice = await login("alice", "pw");
    const sam = await login("sam_the_fisher", "password1234");
    expect(await call("friends.Friends", "Invite", { id: "NOBODY" }, alice)).toMatchObject({ code: "NOT_FOUND" });
    expect(await call("friends.Friends", "Invite", { id: "SAM" }, alice)).toEqual({ ok: true, value: {} });
    expect(await call("misc.Misc", "Event", {}, sam)).toEqual({
      ok: true,
      value: { invite: { id: 1, sender: { id: "ALICE", username: "alice", ips: [] }, force_join: true } },
    });
    expect(await call("misc.Misc", "Event", {}, sam)).toEqual({ ok: true, value: { invite: null } });
  });

  test("TestP2P sends the challenge to the caller over UDP and returns the answer", async () => {
    const token = await login("sam_the_fisher", "password1234");
    const challenge = Buffer.from("0123456789abcdef");
    expect(await call("misc.Misc", "TestP2P", { challenge }, token)).toEqual({ ok: true, value: { challenge } });
  });

  test("reflection lists the public services", async () => {
    const protoDir = join(dirname(Bun.resolveSync("@grpc/reflection/package.json", import.meta.dir)), "build", "proto");
    const reflection = grpc.loadPackageDefinition(
      protoLoader.loadSync("grpc/reflection/v1/reflection.proto", { includeDirs: [protoDir] }),
    ) as any;
    const client = new reflection.grpc.reflection.v1.ServerReflection(address, grpc.credentials.createInsecure());
    const services = await new Promise<string[]>((resolve, reject) => {
      const stream = client.ServerReflectionInfo();
      stream.on("data", (response: any) => {
        resolve(response.listServicesResponse.service.map((s: { name: string }) => s.name));
        stream.end();
      });
      stream.on("error", reject);
      stream.write({ listServices: "" });
    });
    client.close();
    expect(services.sort()).toEqual(["friends.Friends", "misc.Misc", "users.Users", "users.UsersAdmin"]);
  });

  test("admin services need the preshared key", async () => {
    expect(adminKey).toMatch(/^[0-9A-V]{52}$/);
    expect(await call("users.UsersAdmin", "List", {})).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await call("users.UsersAdmin", "List", {}, "wrong")).toMatchObject({ code: "PERMISSION_DENIED" });

    storage.registerUrls(1002, ["prudp:/address=10.0.0.5;port=3074;type=2", "prudp:/address=10.0.0.5;port=3075;type=2"]);
    const users = await call("users.UsersAdmin", "List", {}, adminKey);
    expect(users.ok && users.value.users.find((u: any) => u.id === "SAM")).toEqual({ id: "SAM", username: "sam_the_fisher", ips: ["10.0.0.5"] });
    expect(await call("users.UsersAdmin", "Get", { id: "1002" }, adminKey)).toMatchObject({ ok: true, value: { user: { id: "SAM" } } });
    expect(await call("users.UsersAdmin", "Get", { id: "abc" }, adminKey)).toMatchObject({ code: "INVALID_ARGUMENT" });

    const sessionId = storage.createGameSession(1002, 1, "105 => 2");
    storage.addParticipants(1, sessionId, [1002], [1001]);
    const games = await call("games.GamesAdmin", "List", {}, adminKey);
    expect(games.ok && games.value.games).toContainEqual({ id: sessionId, creator: "sam_the_fisher", participants: ["AAAABBBB"], game_type: "Coop" });
    expect(await call("games.GamesAdmin", "Delete", { id: sessionId }, adminKey)).toEqual({ ok: true, value: {} });

    expect(await call("users.UsersAdmin", "Delete", { id: "ALICE" }, adminKey)).toEqual({ ok: true, value: {} });
    expect(storage.findUserIdByUbiId("ALICE")).toBeUndefined();
  });

  test("the admin key uses the Rust server's base32 alphabet", () => {
    expect(base32(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe("VVVVVVVV");
    expect(base32(Buffer.from([0, 0, 0, 0, 1]))).toBe("00000001");
    expect(base32(Buffer.from([0x80, 0]))).toBe("G000");
    expect(base32(Buffer.alloc(32)).length).toBe(52);
  });
});
