/**
 * gRPC API for the launcher (port of `dedicated_server/src/api.rs`, protos in `proto/`).
 *
 * - `users.Users`: register and log in, returning a token for the other services
 * - `friends.Friends`, `misc.Misc`: need the token in the `authorization` metadata
 * - `users.UsersAdmin`, `games.GamesAdmin`: only with `--launcher`, protected by a preshared
 *   key that is printed on start
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import nacl from "tweetnacl";
import type { DebugConfig } from "../config";
import type { Logger } from "../logger";
import { formatSocketAddress, parseSocketAddress, type SocketAddress } from "../quazal/context";
import { parseProperties, StationURL } from "../quazal/types";
import { isUniqueViolation, type Storage } from "../storage/storage";

const PROTO_DIR = join(import.meta.dir, "..", "..", "proto");
const P2P_TEST_PORT = 13000;
const P2P_TEST_TIMEOUT_MS = 5000;

type Call = grpc.ServerUnaryCall<any, any>;
type Callback = grpc.sendUnaryData<any>;

class ApiError extends Error {
  constructor(
    readonly code: grpc.status,
    message: string,
  ) {
    super(message);
  }
}

/** Custom base32 (0-9A-V) of the Rust server, used for the admin key. */
export function base32(data: Uint8Array) {
  let result = "";
  for (let offset = 0; offset < data.length; offset += 5) {
    const chunk = data.subarray(offset, offset + 5);
    let value = 0n;
    for (const byte of chunk) {
      value = (value << 8n) | BigInt(byte);
    }
    value <<= BigInt(8 * (5 - chunk.length));
    const skip = chunk.length === 5 ? 0 : 8 - Math.floor((chunk.length * 8 + 4) / 5);
    for (let i = 7; i >= skip; i--) {
      const digit = Number((value >> BigInt(5 * i)) & 0b11111n);
      result += digit < 10 ? String(digit) : String.fromCharCode(65 + digit - 10);
    }
  }
  return result;
}

const loadProtos = (files: string[]) =>
  protoLoader.loadSync(files, { includeDirs: [PROTO_DIR], keepCase: true, longs: Number, defaults: true });

function loadServices() {
  const definition = loadProtos(["users.proto", "friends.proto", "misc.proto", "games.proto"]);
  // The package structure comes from the proto files.
  const pkg = grpc.loadPackageDefinition(definition) as any;
  return {
    users: pkg.users.Users.service as grpc.ServiceDefinition,
    usersAdmin: pkg.users.UsersAdmin.service as grpc.ServiceDefinition,
    friends: pkg.friends.Friends.service as grpc.ServiceDefinition,
    misc: pkg.misc.Misc.service as grpc.ServiceDefinition,
    gamesAdmin: pkg.games.GamesAdmin.service as grpc.ServiceDefinition,
  };
}

/** Parses the peer of a call (`1.2.3.4:5678`, `ipv4:1.2.3.4:5678` or `[::1]:5678`). */
function peerAddress(call: Call): SocketAddress {
  return parseSocketAddress(call.getPeer().replace(/^ipv[46]:/, ""));
}

/** Sends `data` to `to` and waits for the answer (`Misc.TestP2P`). */
async function udpRoundTrip(to: SocketAddress, data: Buffer, timeoutMs: number) {
  let resolveAnswer!: (answer: Buffer) => void;
  const answer = new Promise<Buffer>((resolve) => (resolveAnswer = resolve));
  const socket = await Bun.udpSocket({
    connect: { hostname: to.host, port: to.port },
    socket: { data: (_socket, message) => resolveAnswer(Buffer.from(message)) },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    socket.send(data);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ApiError(grpc.status.DEADLINE_EXCEEDED, "client didn't response in time")), timeoutMs);
    });
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

export interface ApiServerOptions {
  logger: Logger;
  storage: Storage;
  address: SocketAddress;
  debug: DebugConfig;
  enableAdminServices: boolean;
  /** Called with the preshared key of the admin services. */
  onAdminKey?: (key: string) => void;
  /** UDP port the launcher listens on during `Misc.TestP2P`. */
  p2pTestPort?: number;
}

export async function startApiServer({
  logger,
  storage,
  address,
  debug,
  enableAdminServices,
  onAdminKey,
  p2pTestPort = P2P_TEST_PORT,
}: ApiServerOptions) {
  const services = loadServices();
  const tokenKey = randomBytes(nacl.secretbox.keyLength);
  const server = new grpc.Server();

  /** Wraps a handler: runs it, logs failures and maps errors to gRPC statuses. */
  const unary =
    (name: string, handler: (call: Call) => unknown | Promise<unknown>, auth?: (call: Call) => void) =>
    async (call: Call, callback: Callback) => {
      try {
        auth?.(call);
        callback(null, await handler(call));
      } catch (e) {
        if (e instanceof ApiError) {
          logger.debug(`${name} failed`, { code: grpc.status[e.code], error: e.message });
          callback({ code: e.code, details: e.message });
        } else {
          logger.error(`${name} failed`, { error: e });
          callback({ code: grpc.status.INTERNAL, details: String((e as Error)?.message ?? e) });
        }
      }
    };

  const authenticated = new WeakMap<Call, number>();
  const userIdOf = (call: Call) => authenticated.get(call)!;

  /** Validates the login token and remembers its user id for the handler. */
  function authenticate(call: Call): number {
    const [token] = call.metadata.get("authorization");
    if (token === undefined) {
      throw new ApiError(grpc.status.UNAUTHENTICATED, "Missing authorization");
    }
    const parts = String(token).split(".");
    if (parts.length !== 2) {
      throw new ApiError(grpc.status.UNAUTHENTICATED, "Invalid token");
    }
    const [ciphertext, nonce] = parts.map((p) => Buffer.from(p, "base64url"));
    const opened =
      nonce.length === nacl.secretbox.nonceLength ? nacl.secretbox.open(ciphertext, nonce, tokenKey) : null;
    if (!opened) {
      throw new ApiError(grpc.status.UNAUTHENTICATED, "Invalid token");
    }
    const userId = Number(Buffer.from(opened).toString());
    if (!Number.isInteger(userId) || storage.findUsernameByUserId(userId) === undefined) {
      throw new ApiError(grpc.status.UNAUTHENTICATED, "Invalid user");
    }
    authenticated.set(call, userId);
    return userId;
  }

  /** `authorization` must be the preshared admin key. */
  let adminKey = "";
  function adminOnly(call: Call) {
    const [token] = call.metadata.get("authorization");
    if (token === undefined) {
      throw new ApiError(grpc.status.UNAUTHENTICATED, "Missing authorization");
    }
    if (String(token) !== adminKey) {
      throw new ApiError(grpc.status.PERMISSION_DENIED, "Invalid token");
    }
  }

  const ipsOf = (userId: number) => [
    ...new Set(
      storage.listUrls(userId).flatMap((url) => {
        try {
          return [StationURL.parse(url).address];
        } catch {
          return [];
        }
      }),
    ),
  ];

  server.addService(services.users, {
    Login: unary("Users.Login", (call) => {
      const { username, password } = call.request;
      const result = storage.loginUser(username, password);
      if (!result.ok) {
        throw result.error === "InvalidPassword"
          ? new ApiError(grpc.status.UNAUTHENTICATED, "Invalid login")
          : new ApiError(grpc.status.NOT_FOUND, "Unknown user");
      }
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const ciphertext = nacl.secretbox(Buffer.from(String(result.userId)), nonce, tokenKey);
      logger.info(`Login successful for ${username}`);
      return {
        error: "",
        token: `${Buffer.from(ciphertext).toString("base64url")}.${Buffer.from(nonce).toString("base64url")}`,
        user: null,
      };
    }),
    Register: unary("Users.Register", (call) => {
      const { username, password, ubi_id } = call.request;
      try {
        storage.registerUser(username, password, ubi_id);
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ApiError(grpc.status.ALREADY_EXISTS, "Username already taken or Ubisoft ID already registered");
        }
        throw new ApiError(grpc.status.INTERNAL, (e as Error).message);
      }
      logger.info(`New user ${username} (${ubi_id}) registered`);
      return { error: "", user: null };
    }),
  });

  server.addService(services.friends, {
    List: unary(
      "Friends.List",
      () => ({
        friends: storage.listUsers().map((u) => ({
          id: u.ubiId,
          username: u.username,
          is_online: u.isOnline || debug.markAllAsOnline,
        })),
      }),
      authenticate,
    ),
    Invite: unary(
      "Friends.Invite",
      (call) => {
        const receiver = storage.findUserIdByUbiId(call.request.id);
        if (receiver === undefined) {
          throw new ApiError(grpc.status.NOT_FOUND, "User not found");
        }
        storage.addInvite(userIdOf(call), receiver);
        return {};
      },
      authenticate,
    ),
  });

  server.addService(services.misc, {
    Event: unary(
      "Misc.Event",
      (call) => {
        const invite = storage.takeInvite(userIdOf(call));
        if (!invite) {
          return { invite: null };
        }
        const sender = storage.findUserById(invite.sender);
        if (!sender) {
          throw new ApiError(grpc.status.NOT_FOUND, "");
        }
        return {
          invite: {
            id: invite.id,
            sender: { id: sender.ubiId ?? "", username: sender.username, ips: [] },
            force_join: debug.forceJoins,
          },
        };
      },
      authenticate,
    ),
    TestP2P: unary(
      "Misc.TestP2P",
      async (call) => {
        const peer = peerAddress(call);
        const challenge = Buffer.concat([Buffer.from("P2P Test - "), Buffer.from(call.request.challenge)]);
        try {
          return { challenge: await udpRoundTrip({ host: peer.host, port: p2pTestPort }, challenge, P2P_TEST_TIMEOUT_MS) };
        } catch (e) {
          if (e instanceof ApiError) {
            throw e;
          }
          throw new ApiError(grpc.status.UNKNOWN, `P2P communication failed: ${(e as Error).message}`);
        }
      },
      authenticate,
    ),
  });

  if (enableAdminServices) {
    logger.warn("Enabling admin services");
    adminKey = base32(randomBytes(32));
    onAdminKey?.(adminKey);

    server.addService(services.usersAdmin, {
      List: unary(
        "UsersAdmin.List",
        () => {
          const users = storage.listUsers().map((u) => ({ id: u.ubiId, username: u.username, ips: ipsOf(u.id) }));
          return { users, total: users.length };
        },
        adminOnly,
      ),
      Get: unary(
        "UsersAdmin.Get",
        (call) => {
          const id = String(call.request.id);
          if (!/^\+?\d+$/.test(id) || Number(id) > 0xffff_ffff) {
            throw new ApiError(grpc.status.INVALID_ARGUMENT, "Invalid ID");
          }
          const user = storage.findUserById(Number(id));
          if (!user) {
            throw new ApiError(grpc.status.NOT_FOUND, "User not found");
          }
          return { user: { id: user.ubiId ?? "", username: user.username, ips: ipsOf(user.id) } };
        },
        adminOnly,
      ),
      Delete: unary(
        "UsersAdmin.Delete",
        (call) => {
          const user = storage.findUserByUbiId(call.request.id);
          if (!user) {
            throw new ApiError(grpc.status.NOT_FOUND, "User not found");
          }
          storage.deleteUser(user.id);
          logger.warn(`Deleted user ${user.username} (${user.id})`);
          return {};
        },
        adminOnly,
      ),
    });

    server.addService(services.gamesAdmin, {
      List: unary(
        "GamesAdmin.List",
        () => ({
          games: storage.listGameSessions().map((session) => {
            let gameType = "Lobby";
            try {
              const type = parseProperties(session.attributes).find((p) => p.id === 105)?.value;
              gameType = type === undefined ? "Lobby" : type === 1 ? "SvM" : type === 2 ? "Coop" : `Unknown(${type})`;
            } catch (e) {
              logger.error("Error parsing game type", { error: (e as Error).message });
            }
            return {
              id: session.sessionId,
              creator: session.participants.find((p) => p.userId === session.creatorId)?.name ?? "",
              participants: session.participants.filter((p) => p.userId !== session.creatorId).map((p) => p.name),
              game_type: gameType,
            };
          }),
        }),
        adminOnly,
      ),
      Delete: unary(
        "GamesAdmin.Delete",
        (call) => {
          storage.deleteGameSessionById(call.request.id);
          logger.warn(`Deleted game session ${call.request.id}`);
          return {};
        },
        adminOnly,
      ),
    });
  }

  // Like the Rust server, only the public services are described (for tools like grpcurl).
  new ReflectionService(loadProtos(["users.proto", "friends.proto", "misc.proto"])).addToServer(server);

  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(formatSocketAddress(address), grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  logger.info(`Listening on ${formatSocketAddress({ ...address, port })}`);
  return { server, port };
}
