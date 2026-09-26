/**
 * Differential tests: the TypeScript server and the Rust reference server (5th-echelon's
 * `dedicated_server`) are started from equivalent `service.toml` files and receive identical
 * traffic. Their answers have to match, apart from values that are random by design.
 *
 * Needs a build of the Rust server:
 *   RUST_SERVER=/path/to/target/debug/dedicated_server bun test test/differential.test.ts
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomInt } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protocols from "../src/protocols";
import { GameSessionExProtocol } from "../src/protocols/game-session-ex-service/game-session-ex-protocol";
import { GameSessionProtocol } from "../src/protocols/game-session-service/game-session-protocol";
import { InitiateProbeRequest, NATTraversalProtocol } from "../src/protocols/nat-traversal/nat-traversal-protocol";
import { SecureConnectionProtocol } from "../src/protocols/secure-connection-service/secure-connection-protocol";
import { TicketGrantingProtocol } from "../src/protocols/authentication-foundation/ticket-granting-protocol";
import { decode, encode } from "../src/quazal/codec";
import { splinterCellBlacklistContext, type SocketAddress } from "../src/quazal/context";
import { decodeKerberosTicket } from "../src/quazal/kerberos";
import { parseRmcPacket, type RmcResponse } from "../src/quazal/rmc/message";
import type { MethodDefinition } from "../src/quazal/rmc/protocol";
import { StationURL } from "../src/quazal/types";
import { loginExParameters, QuazalClient } from "./client";
import { loadRecordedRequests } from "./fixtures/rust-session";
import { DATA_DIR } from "./harness";

const RUST_SERVER = process.env.RUST_SERVER;
const ROOT = join(import.meta.dir, "..");
const ctx = splinterCellBlacklistContext();
const ticketKey = [...randomBytes(32)];

interface Instance {
  name: "rust" | "ts";
  dir: string;
  proc: Subprocess;
  auth: SocketAddress;
  secure: SocketAddress;
  config: SocketAddress;
  content: SocketAddress;
  api: string;
  clients: QuazalClient[];
}

function serviceToml(base: number) {
  return `services = ["onlineconfig", "content", "sc_bl_secure", "sc_bl_auth"]
api_server = "127.0.0.1:${base + 4}"

[debug]
mark_all_as_online = false
force_joins = false

[service.sc_bl_auth]
type = "authentication"
access_key = "yl4NG7qZ"
crypto_key = "CD&ML"
listen = "127.0.0.1:${base}"
vport = 1
secure_server_addr = "127.0.0.1:${base + 1}"
ticket_key = [${ticketKey.join(", ")}]

[service.sc_bl_secure]
type = "secure"
access_key = "yl4NG7qZ"
crypto_key = "CD&ML"
listen = "127.0.0.1:${base + 1}"
vport = 1
ticket_key = [${ticketKey.join(", ")}]

[service.sc_bl_secure.settings]
storage_host = "127.0.0.1:8000"
storage_path = "/mp_balancing.ini"

[service.onlineconfig]
type = "config"
listen = "127.0.0.1:${base + 2}"

[[service.onlineconfig.content]]
Name = "SandboxUrl"
Values = ["prudp:/address=127.0.0.1;port=21126"]

[[service.onlineconfig.content]]
Name = "SandboxUrlWS"
Values = ["127.0.0.1:21126"]

[service.content]
type = "content"
listen = "127.0.0.1:${base + 3}"

[service.content.files]
"/mp_balancing.ini" = "./data/mp_balancing.ini"
`;
}

async function waitFor(check: () => Promise<unknown>, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() > deadline) {
        throw new Error(`${what} did not start: ${(e as Error).message}`);
      }
      await Bun.sleep(200);
    }
  }
}

function tcpReachable(address: SocketAddress) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(address.port, address.host, () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function launch(name: Instance["name"], command: string[], base: number): Promise<Instance> {
  const dir = mkdtempSync(join(tmpdir(), `sc6-${name}-`));
  cpSync(DATA_DIR, join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "service.toml"), serviceToml(base));
  const proc = Bun.spawn(command, {
    cwd: dir,
    env: { ...process.env, RUST_LOG: "warning", LOG_LEVEL: "warn" },
    stdout: Bun.file(join(dir, "stdout.log")),
    stderr: Bun.file(join(dir, "stderr.log")),
  });
  const instance: Instance = {
    name,
    dir,
    proc,
    auth: { host: "127.0.0.1", port: base },
    secure: { host: "127.0.0.1", port: base + 1 },
    config: { host: "127.0.0.1", port: base + 2 },
    content: { host: "127.0.0.1", port: base + 3 },
    api: `127.0.0.1:${base + 4}`,
    clients: [],
  };
  for (const target of [instance.auth, instance.secure]) {
    await waitFor(async () => {
      const c = await QuazalClient.open(ctx, target);
      try {
        await c.syn(300);
      } finally {
        c.close();
      }
    }, `${name} PRUDP ${target.port}`);
  }
  for (const target of [instance.config, instance.content, { host: "127.0.0.1", port: base + 4 }]) {
    await waitFor(() => tcpReachable(target), `${name} TCP ${target.port}`);
  }
  return instance;
}

async function client(instance: Instance, to: "auth" | "secure") {
  const c = await QuazalClient.open(ctx, instance[to]);
  instance.clients.push(c);
  return c;
}

/** Replaces values that may legitimately differ in order (maps, station url parameters). */
function normalize(value: unknown): unknown {
  if (value instanceof StationURL) {
    const params = [...value.params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
    return `${value.scheme}:/address=${value.address};port=${value.port};${params.join(";")}`;
  }
  if (value instanceof Map) {
    return [...value]
      .map(([k, v]) => [normalize(k), normalize(v)])
      .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

const methods = new Map<string, MethodDefinition>();
for (const protocol of Object.values(protocols)) {
  if (protocol.id !== undefined) {
    for (const method of Object.values(protocol.methods)) {
      methods.set(`${protocol.id}/${method.id}`, method);
    }
  }
}

let rust: Instance;
let ts: Instance;

describe.skipIf(!RUST_SERVER)("TypeScript server vs Rust server", () => {
  beforeAll(async () => {
    const base = 20000 + randomInt(0, 4000) * 10;
    [rust, ts] = await Promise.all([
      launch("rust", [RUST_SERVER!], base),
      launch("ts", [process.execPath, "run", join(ROOT, "src", "main.ts")], base + 5),
    ]);
  }, 120_000);

  afterAll(() => {
    for (const instance of [rust, ts]) {
      if (!instance) continue;
      instance.clients.forEach((c) => c.close());
      instance.proc.kill();
      if (!process.env.KEEP_DIFF_DIRS) {
        rmSync(instance.dir, { recursive: true, force: true });
      } else {
        console.log(`${instance.name} logs in ${instance.dir}`);
      }
    }
  });

  /** Runs the same scenario on both servers (Rust first) and returns both results. */
  async function both<T>(scenario: (instance: Instance) => Promise<T>): Promise<[T, T]> {
    const a = await scenario(rust);
    const b = await scenario(ts);
    return [a, b];
  }

  describe("HTTP services", () => {
    function rawHttp(address: SocketAddress, request: string) {
      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = connect(address.port, address.host, () => socket.write(request));
        socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
        socket.on("error", reject);
      });
    }

    test("online config responses are identical", async () => {
      const [a, b] = await both((i) => rawHttp(i.config, "GET /OnlineConfigService.svc/GetOnlineConfig?onlineConfigID=x HTTP/1.1\r\nHost: x\r\n\r\n"));
      expect(b).toBe(a);
      expect(a).toStartWith("HTTP/1.0 200 OK\r\n");
    });

    test.each([
      ["GET /mp_balancing.ini HTTP/1.1\r\n\r\n", "200"],
      ["GET /missing HTTP/1.1\r\n\r\n", "404"],
      ["POST /mp_balancing.ini HTTP/1.1\r\n\r\n", "405"],
      ["GET /mp_balancing.ini HTTP/1.0\r\n\r\n", "400"],
    ])("content service answers %j identically", async (request, status) => {
      const [a, b] = await both((i) => rawHttp(i.content, request));
      expect(b).toBe(a);
      expect(a).toStartWith(`HTTP/1.0 ${status}`);
    });
  });

  describe("gRPC API", () => {
    const definition = protoLoader.loadSync(["users.proto", "friends.proto", "misc.proto"], {
      includeDirs: [join(ROOT, "proto")],
      keepCase: true,
      longs: Number,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(definition) as any;

    type Result = { ok: true; value: any } | { ok: false; code: string; details: string };

    function call(instance: Instance, service: string, method: string, request: object, token?: string): Promise<Result> {
      const [ns, name] = service.split(".");
      const stub = new pkg[ns][name](instance.api, grpc.credentials.createInsecure());
      const metadata = new grpc.Metadata();
      if (token) {
        metadata.set("authorization", token);
      }
      return new Promise((resolve) =>
        stub[method](request, metadata, (error: grpc.ServiceError | null, value: unknown) => {
          stub.close();
          resolve(error ? { ok: false, code: grpc.status[error.code], details: error.details } : { ok: true, value });
        }),
      );
    }

    async function token(instance: Instance, username: string, password: string) {
      const result = await call(instance, "users.Users", "Login", { username, password });
      if (!result.ok) throw new Error(`login failed: ${result.details}`);
      return result.value.token as string;
    }

    test("registration and login", async () => {
      const scenario = async (i: Instance) => [
        await call(i, "users.Users", "Register", { username: "diff_user", password: "secret", ubi_id: "DIFF" }),
        await call(i, "users.Users", "Register", { username: "diff_user", password: "other", ubi_id: "DIFF2" }),
        await call(i, "users.Users", "Login", { username: "diff_user", password: "wrong" }),
        await call(i, "users.Users", "Login", { username: "nobody", password: "x" }),
      ];
      const [a, b] = await both(scenario);
      expect(b).toEqual(a);
      expect(a[0].ok).toBe(true);
      expect(a[1]).toMatchObject({ ok: false, code: "ALREADY_EXISTS" });

      const [ta, tb] = await both((i) => token(i, "diff_user", "secret"));
      expect(ta).toMatch(/^[\w-]+\.[\w-]+$/);
      expect(tb).toMatch(/^[\w-]+\.[\w-]+$/);
    });

    test("authenticated services", async () => {
      const scenario = async (i: Instance) => {
        const sam = await token(i, "sam_the_fisher", "password1234");
        const diff = await token(i, "diff_user", "secret");
        const list = await call(i, "friends.Friends", "List", {}, sam);
        if (list.ok) list.value.friends.sort((x: any, y: any) => x.id.localeCompare(y.id));
        return [
          await call(i, "friends.Friends", "List", {}),
          await call(i, "friends.Friends", "List", {}, "garbage.token"),
          list,
          await call(i, "friends.Friends", "Invite", { id: "UNKNOWN" }, diff),
          await call(i, "friends.Friends", "Invite", { id: "SAM" }, diff),
          await call(i, "misc.Misc", "Event", {}, sam),
          await call(i, "misc.Misc", "Event", {}, sam),
        ];
      };
      const [a, b] = await both(scenario);
      expect(b).toEqual(a);
      expect(a[0]).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
      expect(a[5]).toMatchObject({ ok: true, value: { invite: { sender: { username: "diff_user" } } } });
    });
  });

  describe("Quazal services", () => {
    test("handshake packets", async () => {
      const [a, b] = await both(async (i) => {
        const c = await client(i, "auth");
        const syn = await c.syn();
        const con = await c.connect();
        const shape = (p: typeof syn) => ({
          type: p.packetType,
          flags: p.flags,
          source: p.source,
          destination: p.destination,
          sequence: p.sequence,
          signatureIsClients: p.signature === c.connSignature,
          connSignature: p.connSignature === 0 ? 0 : "random",
          payload: p.payload.toString("hex"),
        });
        return [shape(syn), shape(con)];
      });
      expect(b).toEqual(a);
    });

    test("recorded game session replays identically", async () => {
      const recorded = loadRecordedRequests();
      const replay = async (i: Instance) => {
        const authMain = await client(i, "auth");
        const authTracking = await client(i, "auth");
        await authMain.syn();
        await authMain.connect();
        await authTracking.syn();
        await authTracking.connect();
        let secureMain: QuazalClient | undefined;
        let secureTracking: QuazalClient | undefined;

        const results: unknown[] = [];
        for (const request of recorded) {
          const via: Record<number, () => QuazalClient | undefined> = {
            0x747e2a38: () => authMain,
            0x7bae48fd: () => authTracking,
            0x97213d97: () => secureMain,
            0x2044d2ae: () => secureTracking,
          };
          const c = via[request.connection]();
          if (!c) throw new Error(`no connection for ${request.connection.toString(16)}`);
          const response = await c.callRaw(request.protocolId, request.methodId, request.parameters);
          const tracking = c === authTracking || c === secureTracking;
          results.push(
            describeResponse(request.protocolId, request.methodId, response, {
              password: tracking ? "JaDe!" : undefined,
              userPid: tracking ? 105 : 1002,
              client: c,
              securePort: i.secure.port,
            }),
          );

          // Connect to the secure service with the ticket, like the game does.
          if (request.protocolId === 10 && request.methodId === 3 && response.result.ok) {
            const { bufResponse } = decode(TicketGrantingProtocol.methods.requestTicket.response, response.result.data);
            const userPid = tracking ? 105 : 1002;
            const ticket = decodeKerberosTicket(bufResponse, userPid, tracking ? "JaDe!" : undefined);
            const secure = await client(i, "secure");
            const { ack, challenge } = await secure.connectWithTicket(ticket.sealedInternal, ticket.sessionKey, userPid);
            expect(ack.payload.readUInt32LE(4)).toBe((challenge + 1) >>> 0);
            if (tracking) secureTracking = secure;
            else secureMain = secure;
          }
        }
        return results;
      };

      const [a, b] = await both(replay);
      expect(a).toHaveLength(recorded.length);
      for (let k = 0; k < a.length; k++) {
        const { protocolId, methodId } = recorded[k];
        expect({ call: `${protocolId}/${methodId}`, result: b[k] }).toEqual({ call: `${protocolId}/${methodId}`, result: a[k] });
      }
    }, 60_000);

    test("login failures, unknown protocols and malformed requests", async () => {
      const [a, b] = await both(async (i) => {
        const c = await client(i, "auth");
        await c.syn();
        await c.connect();
        const results = [];
        for (const [protocol, method, params] of [
          [10, 2, encode(TicketGrantingProtocol.methods.loginEx.request, loginExParameters("sam_the_fisher", "wrong"))],
          [10, 2, encode(TicketGrantingProtocol.methods.loginEx.request, loginExParameters("ghost", "x"))],
          [10, 3, encode(TicketGrantingProtocol.methods.requestTicket.request, { idSource: 1002, idTarget: 1 })],
          [10, 5, encode(TicketGrantingProtocol.methods.getName.request, { id: 1 })],
          [10, 99, Buffer.alloc(0)],
          [10, 2, Buffer.from([0xff, 0xff])],
          [77, 1, Buffer.alloc(0)],
          [5003, 1, Buffer.alloc(0)],
        ] as const) {
          results.push(describeResponse(protocol, method, await c.callRaw(protocol, method, Buffer.from(params))));
        }
        return results;
      });
      expect(b).toEqual(a);
    });

    test("Login for accounts without a plaintext password (deliberate deviation)", async () => {
      const [a, b] = await both(async (i) => {
        const c = await client(i, "auth");
        await c.syn();
        await c.connect();
        const response = await c.callRaw(10, 1, encode(TicketGrantingProtocol.methods.login.request, { strUserName: "sam_the_fisher" }));
        return response.result.ok ? "ticket" : response.result.errorCode;
      });
      // The Rust server hands out a ticket encrypted with the public default password.
      expect(a).toBe("ticket");
      expect(b).toBe(0x80010006);
    });

    test("game sessions and NAT probes between two players", async () => {
      async function player(i: Instance, username: string, password: string) {
        const auth = await client(i, "auth");
        await auth.syn();
        await auth.connect();
        const login = await auth.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.loginEx, loginExParameters(username, password));
        const ticket = decodeKerberosTicket(login.pbufResponse, login.pidPrincipal);
        const secure = await client(i, "secure");
        await secure.connectWithTicket(ticket.sealedInternal, ticket.sessionKey, login.pidPrincipal);
        const registration = await secure.call(SecureConnectionProtocol, SecureConnectionProtocol.methods.register, {
          vecMyUrls: [StationURL.parse("prudp:/address=10.0.0.1;port=3074;sid=15;type=2")],
        });
        return { secure, registration };
      }

      const [a, b] = await both(async (i) => {
        const host = await player(i, "sam_the_fisher", "password1234");
        const guest = await player(i, "diff_user", "secret");
        const results: unknown[] = [];
        const attributes = "113 => 0;109 => 0;110 => 0;106 => 3564829;107 => 3909881133;108 => 0;3 => 2;4 => 0;101 => 3578398534;102 => 3;103 => 0;105 => 2;112 => 2"
          .split(";")
          .map((e) => e.split(" => ").map(Number))
          .map(([id, value]) => ({ id, value }));
        const created = await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.createSession, {
          gameSession: { typeId: 1, attributes },
        });
        results.push(normalize(created));
        const key = created.gameSessionKey;
        await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.registerUrls, {
          stationUrls: [StationURL.parse(`prudp:/address=10.0.0.1;port=3074;RVCID=${host.registration.pidConnectionId};type=2`)],
        });
        await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.addParticipants, {
          gameSessionKey: key,
          publicParticipantIds: [],
          privateParticipantIds: [1002],
        });
        const query = { typeId: 1, queryId: 0, parameters: [{ id: 106, value: 3564829 }, { id: 112, value: 1 }] };
        results.push(normalize(await guest.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, { gameSessionQuery: query })));
        results.push(normalize(await host.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, { gameSessionQuery: query })));
        results.push(
          normalize(
            await guest.secure.call(GameSessionProtocol, GameSessionProtocol.methods.searchSessionsWithParticipants, {
              gameSessionTypeId: 1,
              participantIds: [1002],
            }),
          ),
        );

        // The guest asks the server to make the host probe it.
        const probe = StationURL.parse("prudp:/address=10.0.0.2;port=3074;type=2");
        await guest.secure.call(NATTraversalProtocol, NATTraversalProtocol.methods.requestProbeInitiationExt, {
          urlTargetList: [StationURL.parse(`prudp:/address=10.0.0.1;port=3074;RVCID=${host.registration.pidConnectionId};type=2`)],
          urlStationToProbe: probe,
        });
        const message = parseRmcPacket(await host.secure.receiveRmc());
        if (message.type !== "request") throw new Error("expected a request");
        results.push({
          protocolId: message.request.protocolId,
          methodId: message.request.methodId,
          params: normalize(decode(InitiateProbeRequest, message.request.parameters)),
        });

        await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.deleteSession, { gameSessionKey: key });
        results.push(normalize(await guest.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, { gameSessionQuery: query })));
        return results;
      });
      expect(b).toEqual(a);
    });
  });
});

/** A comparable view of an RMC response; random parts are checked and replaced by placeholders. */
function describeResponse(
  protocolId: number,
  methodId: number,
  response: RmcResponse,
  {
    password,
    userPid,
    client: c,
    securePort,
  }: { password?: string; userPid?: number; client?: QuazalClient; securePort?: number } = {},
) {
  const { result } = response;
  if (!result.ok) {
    return { protocolId: response.protocolId, error: `0x${result.errorCode.toString(16)}` };
  }
  const method = methods.get(`${protocolId}/${methodId}`);
  if (!method || protocolId >= 5000) {
    return { protocolId: response.protocolId, methodId: result.methodId, raw: result.data.toString("hex") };
  }
  const value = decode(method.response, result.data) as Record<string, any>;
  // Decoding and encoding again must give the exact bytes the server sent.
  expect(encode(method.response, value).toString("hex")).toBe(result.data.toString("hex"));

  if (protocolId === 10) {
    // Tickets contain a random session key and nonce: compare what the client can decrypt.
    const field = "pbufResponse" in value ? "pbufResponse" : "bufResponse";
    const ticket = decodeKerberosTicket(value[field], value.pidPrincipal ?? userPid, password);
    value[field] = { pid: ticket.pid, sealedLength: ticket.sealedInternal.length };
    // Points to the instance's own secure service.
    const url = value.pConnectionData?.urlRegularProtocols;
    if (url && url.scheme === "prudps") {
      expect(url.port).toBe(securePort);
      url.port = 0;
    }
  }
  if (protocolId === 107 && methodId === 1) {
    expect(Math.abs(value.time - Date.now() / 1000)).toBeLessThan(30);
    value.time = "<now>";
  }
  if (protocolId === 11 && c) {
    expect(value.urlPublic.port).toBe(c.localAddress.port);
    value.urlPublic.port = 0;
  }
  return { protocolId: response.protocolId, methodId: result.methodId, value: normalize(value) };
}
