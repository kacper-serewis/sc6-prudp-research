/**
 * End-to-end tests: a client that behaves like the game talks UDP to the servers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TicketGrantingProtocol } from "../src/protocols/authentication-foundation/ticket-granting-protocol";
import { ClanHelperProtocol } from "../src/protocols/clan-helper-service/clan-helper-protocol";
import { GameSessionExProtocol } from "../src/protocols/game-session-ex-service/game-session-ex-protocol";
import { GameSessionProtocol } from "../src/protocols/game-session-service/game-session-protocol";
import { LadderHelperProtocol } from "../src/protocols/ladder-helper-service/ladder-helper-protocol";
import { NATTraversalProtocol } from "../src/protocols/nat-traversal/nat-traversal-protocol";
import { PlayerStatsProtocol } from "../src/protocols/player-stats-service/player-stats-protocol";
import { PrivilegesProtocol } from "../src/protocols/privileges-service/privileges-protocol";
import { SecureConnectionProtocol } from "../src/protocols/secure-connection-service/secure-connection-protocol";
import { UbiAccountManagementProtocol } from "../src/protocols/ubi-account-management-service/ubi-account-management-protocol";
import { UserStorageProtocol } from "../src/protocols/user-storage/user-storage-protocol";
import { InitiateProbeRequest } from "../src/protocols/nat-traversal/nat-traversal-protocol";
import { decode, encode, list, string, struct, u32 } from "../src/quazal/codec";
import { PacketFlag, PacketType, QPacket, StreamType } from "../src/quazal/prudp/packet";
import { parseRmcPacket } from "../src/quazal/rmc/message";
import { StationURL } from "../src/quazal/types";
import { NewsItem } from "../src/services/overlord";
import { loginExParameters, openLoginTicket, QuazalClient, RmcCallError } from "./client";
import { startTestServers } from "./harness";

let servers: Awaited<ReturnType<typeof startTestServers>>;
const clients: QuazalClient[] = [];

beforeAll(async () => {
  servers = await startTestServers();
});

afterAll(() => {
  clients.forEach((c) => c.close());
  servers.close();
});

async function client(to: "auth" | "secure") {
  const c = await QuazalClient.open(servers.ctx, servers[to].address);
  clients.push(c);
  return c;
}

/** Logs in like the game: LoginEx on the authentication service, then CONNECT to the secure service. */
async function login(username = "sam_the_fisher", password = "password1234") {
  const auth = await client("auth");
  await auth.syn();
  await auth.connect();
  const response = await auth.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.loginEx, loginExParameters(username, password));
  const ticket = openLoginTicket(response);
  const secure = await client("secure");
  const { ack, challenge } = await secure.connectWithTicket(ticket.sealedInternal, ticket.sessionKey, response.pidPrincipal);
  return { auth, secure, response, ticket, ack, challenge };
}

const expectRmcError = async (promise: Promise<unknown>, code: number) => {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(RmcCallError);
  expect((error as RmcCallError).errorCode).toBe(code);
};

describe("authentication service", () => {
  test("handshake: SYN-ACK carries the server signature, CONNECT is acknowledged", async () => {
    const c = await client("auth");
    const synAck = await c.syn();
    expect(synAck.hasFlag(PacketFlag.Ack)).toBe(true);
    expect(synAck.connSignature).not.toBe(0);
    const connectAck = await c.connect();
    expect(connectAck.connSignature).toBe(0);
    expect(connectAck.signature).toBe(c.connSignature);
    expect(connectAck.payload.length).toBe(0);
  });

  test("LoginEx returns a ticket for the secure service", async () => {
    const { response, ticket } = await login();
    expect(response.returnValue).toBe(0x10001);
    expect(response.pidPrincipal).toBe(1002);
    expect(response.strReturnMsg).toBe("");
    expect(response.pConnectionData.urlRegularProtocols.toString()).toBe(
      `prudps:/address=127.0.0.1;port=${servers.secure.address.port};CID=1;PID=4096;sid=1;stream=3;type=2`,
    );
    expect(response.pConnectionData.urlSpecialProtocols.toString()).toBe(":/address=;port=0");
    expect(ticket.pid).toBe(0x1000);
    expect(ticket.sessionKey.length).toBe(16);
  });

  test("LoginEx rejects wrong passwords and unknown users", async () => {
    const c = await client("auth");
    await c.syn();
    await c.connect();
    await expectRmcError(
      c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.loginEx, loginExParameters("sam_the_fisher", "nope")),
      0x80010006,
    );
    await expectRmcError(
      c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.loginEx, loginExParameters("ghost", "x")),
      0x80010006,
    );
  });

  test("Login works for the built-in Tracking account and RequestTicket needs a login", async () => {
    const c = await client("auth");
    await c.syn();
    await c.connect();
    await expectRmcError(c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.requestTicket, { idSource: 105, idTarget: 0x1000 }), 0x80010006);

    const response = await c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.login, { strUserName: "Tracking" });
    expect(response.pidPrincipal).toBe(105);
    expect(response.pConnectionData.urlRegularProtocols.params.get("PID")).toBe("2");
    // Encrypted with the account's plaintext password.
    expect(() => openLoginTicket(response)).toThrow("MAC mismatch");
    expect(openLoginTicket(response, "JaDe!").pid).toBe(0x1000);

    const ticket = await c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.requestTicket, { idSource: 105, idTarget: 0x1000 });
    expect(openLoginTicket({ ...response, pbufResponse: ticket.bufResponse }, "JaDe!").pid).toBe(0x1000);
  });

  test("Login is refused for accounts without a plaintext password", async () => {
    const c = await client("auth");
    await c.syn();
    await c.connect();
    await expectRmcError(c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.login, { strUserName: "sam_the_fisher" }), 0x80010006);
  });

  test("unknown protocols and unimplemented methods", async () => {
    const c = await client("auth");
    await c.syn();
    await c.connect();
    const unknown = await c.callRaw(99, 1, Buffer.alloc(0));
    expect(unknown).toMatchObject({ protocolId: 99, result: { ok: false, errorCode: 0x80010001 } });
    await expectRmcError(c.call(TicketGrantingProtocol, TicketGrantingProtocol.methods.getName, { id: 1 }), 0x80010002);
    const malformed = await c.callRaw(10, 2, Buffer.from([0xff]));
    expect(malformed.result).toMatchObject({ ok: false, errorCode: 0x8001000a });
  });
});

describe("secure service", () => {
  test("CONNECT with a ticket answers the challenge and assigns the user", async () => {
    const { secure, ack, challenge } = await login();
    // The payload is a buffer holding challenge + 1.
    expect(ack.payload).toEqual(Buffer.concat([encode(u32, 4), encode(u32, (challenge + 1) >>> 0)]));

    const registered = await secure.call(SecureConnectionProtocol, SecureConnectionProtocol.methods.registerEx, {
      vecMyUrls: [StationURL.parse("prudp:/address=192.168.1.60;port=3074;sid=15;type=3")],
      hCustomData: { typeName: "UbiAuthenticationLoginCustomData", data: Buffer.alloc(0) },
    });
    expect(registered.returnValue).toBe(0x10001);
    expect(registered.pidConnectionId).toBeGreaterThanOrEqual(0x3aaaaaaa);
    expect(registered.urlPublic.toString()).toBe(`prudp:/address=127.0.0.1;port=${secure.localAddress.port};sid=15;type=3`);
  });

  test("calls without a valid ticket are denied", async () => {
    const c = await client("secure");
    await c.syn();
    await c.connect();
    await expectRmcError(c.call(LadderHelperProtocol, LadderHelperProtocol.methods.getUnixUtc, {}), 0x80010006);

    const forged = await client("secure");
    const { ack } = await forged.connectWithTicket(Buffer.alloc(68, 1), Buffer.alloc(16, 2), 1002);
    expect(ack.payload.length).toBe(0);
    await expectRmcError(forged.call(LadderHelperProtocol, LadderHelperProtocol.methods.getUnixUtc, {}), 0x80010006);
  });

  test("fixed data protocols", async () => {
    const { secure } = await login();
    const { time } = await secure.call(LadderHelperProtocol, LadderHelperProtocol.methods.getUnixUtc, {});
    expect(Math.abs(time - Date.now() / 1000)).toBeLessThan(5);

    const { privileges } = await secure.call(PrivilegesProtocol, PrivilegesProtocol.methods.getPrivileges, { localeCode: "en-US" });
    expect(privileges).toEqual(new Map([[1, { id: 1, description: "PlayOnline" }]]));

    const clan = await secure.call(ClanHelperProtocol, ClanHelperProtocol.methods.getClanInfoByPid, { targetPid: 1002 });
    expect(clan.clanInfo).toEqual({ clid: 0xffffffff, tag: "TEST", title: "FOO", motto: "BAR" });

    const stats = await secure.call(PlayerStatsProtocol, PlayerStatsProtocol.methods.readStatsByPlayers, { playerPids: [1002], queries: [] });
    expect(stats.results[0].playerStatSets[0].playerPid).toBe(1002);
    expect(stats.results[0].playerStatSets[0].stats).toHaveLength(9);

    const content = await secure.call(UserStorageProtocol, UserStorageProtocol.methods.getContentUrl, { contentKey: { typeId: 1, contentId: 1n } });
    expect(content.downloadInfo).toEqual({ protocol: "http://", host: "127.0.0.1:8000", path: "/mp_balancing.ini" });
  });

  test("account lookups", async () => {
    const { secure } = await login();
    const { pids } = await secure.call(UbiAccountManagementProtocol, UbiAccountManagementProtocol.methods.lookupPrincipalIds, {
      ubiAccountIds: ["MYID", "ABCD", "unknown"],
    });
    expect(pids).toEqual(new Map([["MYID", 1000], ["ABCD", 1001]]));
    const { ubiaccountIds } = await secure.call(UbiAccountManagementProtocol, UbiAccountManagementProtocol.methods.lookupUbiAccountIdsByPids, {
      pids: [1000, 1002, 5],
    });
    expect(ubiaccountIds).toEqual(new Map([[1000, "MYID"], [1002, "SAM"]]));
  });

  test("overlord core config matches the Rust server byte for byte (and is sent in two fragments)", async () => {
    const { secure } = await login();
    const response = await secure.callRaw(5003, 1, Buffer.alloc(0));
    expect(response.result.ok).toBe(true);
    const expected = readFileSync(new URL("./fixtures/overlord_core_config.bin", import.meta.url));
    expect(response.result.ok && response.result.data.equals(expected)).toBe(true);
  });

  test("overlord news and challenges come from the data directory", async () => {
    const { secure } = await login();
    const news = await secure.callRaw(5002, 1, Buffer.alloc(0));
    if (!news.result.ok) throw new Error("news failed");
    // data/news.json
    expect(decode(list(NewsItem), news.result.data).map((n) => n.title)).toEqual(["WELCOME BACK!", "Hello"]);

    const challenges = await secure.callRaw(5007, 1, encode(struct({ class: string }), { class: "ProtoChallengeFilter" }));
    // data/challenges.json is an empty list
    expect(challenges.result.ok && challenges.result.data.toString("hex")).toBe("00000000");
    const unknown = await secure.callRaw(5007, 5, Buffer.alloc(0));
    expect(unknown.result).toMatchObject({ ok: false, errorCode: 0x80010001 });
  });

  test("large requests are reassembled from fragments", async () => {
    const { secure } = await login();
    const urls = Array.from({ length: 40 }, (_, i) => StationURL.parse(`prudp:/address=10.0.0.${i};port=3074;RVCID=${i};type=2`));
    const request = encode(GameSessionProtocol.methods.registerUrls.request, { stationUrls: urls });
    expect(request.length).toBeGreaterThan(1500);
    const response = await secure.callRaw(GameSessionProtocol.id, GameSessionProtocol.methods.registerUrls.id, request, 500);
    expect(response.result.ok).toBe(true);
    expect(servers.storage.listUrls(1002)).toHaveLength(40);
    // Disconnecting removes the user's station urls again.
    await secure.disconnect();
    expect(servers.storage.listUrls(1002)).toEqual([]);
  });

  test("game sessions: create, search, join and delete", async () => {
    const host = await login();
    // A coop session as created by the game (from the notes in game_session_ex.rs).
    const attributes = "113 => 0;109 => 0;110 => 0;106 => 3564829;107 => 3909881133;108 => 0;3 => 2;4 => 0;101 => 3578398534;102 => 3;103 => 0;105 => 2;112 => 2"
      .split(";")
      .map((entry) => entry.split(" => ").map(Number))
      .map(([id, value]) => ({ id, value }));
    const { gameSessionKey } = await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.createSession, {
      gameSession: { typeId: 1, attributes },
    });
    expect(gameSessionKey.typeId).toBe(1);
    await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.registerUrls, {
      stationUrls: [StationURL.parse("prudp:/address=10.1.1.1;port=3074;type=2")],
    });
    await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.addParticipants, {
      gameSessionKey,
      publicParticipantIds: [],
      privateParticipantIds: [1002],
    });

    // The host doesn't find its own session, another player does.
    servers.storage.registerUser("guest", "guest-password", "GUEST");
    const guest = await login("guest", "guest-password");
    // The game's coop search; 103 is not sent and defaults to 0, 112 is ignored.
    const query = {
      typeId: 1,
      queryId: 0,
      parameters: [
        { id: 106, value: 3564829 },
        { id: 107, value: 3909881133 },
        { id: 108, value: 0 },
        { id: 112, value: 1 },
      ],
    };
    const own = await host.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, { gameSessionQuery: query });
    expect(own.searchResults).toEqual([]);
    const { searchResults } = await guest.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, {
      gameSessionQuery: query,
    });
    expect(searchResults).toHaveLength(1);
    const [result] = searchResults;
    expect(result.gameSessionSearchResult.sessionKey).toEqual(gameSessionKey);
    expect(result.gameSessionSearchResult.hostPid).toBe(1002);
    expect(result.gameSessionSearchResult.hostUrls.map(String)).toEqual(["prudp:/address=10.1.1.1;port=3074;type=2"]);
    expect(result.gameSessionSearchResult.attributes).toEqual(attributes);
    expect(result.participants.map((p) => p.name)).toEqual(["sam_the_fisher"]);

    // SvM searches (attribute 103) must not find coop sessions.
    const svm = await guest.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, {
      gameSessionQuery: { ...query, parameters: [{ id: 103, value: 2165463540 }] },
    });
    expect(svm.searchResults).toEqual([]);

    const withParticipants = await guest.secure.call(GameSessionProtocol, GameSessionProtocol.methods.searchSessionsWithParticipants, {
      gameSessionTypeId: 1,
      participantIds: [1002],
    });
    expect(withParticipants.searchResults.map((r) => r.participantIds)).toEqual([[1002]]);

    await host.secure.call(GameSessionProtocol, GameSessionProtocol.methods.deleteSession, { gameSessionKey });
    const after = await guest.secure.call(GameSessionExProtocol, GameSessionExProtocol.methods.searchSessions, { gameSessionQuery: query });
    expect(after.searchResults).toEqual([]);
  });

  test("NAT probe requests are relayed to the target client", async () => {
    const a = await login();
    const b = await login();
    const bRegistration = await b.secure.call(SecureConnectionProtocol, SecureConnectionProtocol.methods.register, {
      vecMyUrls: [StationURL.parse("prudp:/address=127.0.0.1;port=3074;sid=15;type=2")],
    });
    const probe = StationURL.parse("prudp:/address=5.6.7.8;port=3074;type=2");
    await a.secure.call(NATTraversalProtocol, NATTraversalProtocol.methods.requestProbeInitiationExt, {
      urlTargetList: [StationURL.parse(`prudp:/address=127.0.0.1;port=3074;RVCID=${bRegistration.pidConnectionId};type=2`)],
      urlStationToProbe: probe,
    });
    const message = parseRmcPacket(await b.secure.receiveRmc());
    expect(message.type).toBe("request");
    if (message.type === "request") {
      expect(message.request.protocolId).toBe(3);
      expect(message.request.methodId).toBe(2);
      expect(decode(InitiateProbeRequest, message.request.parameters).urlStationToProbe.toString()).toBe(probe.toString());
    }
  });

  test("USER packets are echoed with the observed address", async () => {
    const c = await client("secure");
    // NAT echo request from quazal's packet tests: USER packet on stream NATEcho, port 1.
    const packet = Buffer.from("qq\x05\x00\x00\x00\x00\x00\x00\x00\x01\x053\x00\x00\x00\x00\xdcJ\x8d{\x80\x00\x01\x03\xd4", "latin1");
    c.sendRaw(packet);
    const echo = await c.receiveRaw();
    const payload = packet.subarray(10, packet.length - 1);
    expect(echo).toEqual(Buffer.concat([payload, Buffer.from(`udp:/address=127.0.0.1;port=${c.localAddress.port}\0`)]));
  });

  test("compressed USER packets are not echoed (no traffic amplification)", async () => {
    const c = await client("secure");
    c.sendPacket(
      new QPacket({
        source: { port: 1, streamType: StreamType.RVSec },
        destination: { port: 1, streamType: StreamType.RVSec },
        packetType: PacketType.User,
        payload: Buffer.alloc(60_000),
        useCompression: true,
      }),
    );
    await expect(c.receiveRaw(300)).rejects.toThrow("timed out");
  });

  test("ping keeps the session alive and disconnect cleans it up", async () => {
    const { secure } = await login();
    await secure.call(GameSessionProtocol, GameSessionProtocol.methods.registerUrls, {
      stationUrls: [StationURL.parse("prudp:/address=10.9.9.9;port=3074;type=2")],
    });
    const ping = await secure.ping();
    expect(ping.hasFlag(PacketFlag.Ack)).toBe(true);
    expect(servers.secure.server.clients.has(secure.signature)).toBe(true);

    await secure.disconnect();
    expect(servers.secure.server.clients.has(secure.signature)).toBe(false);
    expect(servers.storage.listUrls(1002)).not.toContain("prudp:/address=10.9.9.9;port=3074;type=2");
  });

  test("clients that stop talking expire", async () => {
    const { secure } = await login();
    expect(servers.secure.server.clients.has(secure.signature)).toBe(true);
    servers.secure.server.clearExpiredClients(Date.now() + 61_000);
    expect(servers.secure.server.clients.has(secure.signature)).toBe(false);
  });
});
