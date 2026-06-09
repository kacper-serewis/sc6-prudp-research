import debug from "debug";
import _sodium from "libsodium-wrappers";
import crypto from "node:crypto";
import { type Context, splinterCellBlacklistContext } from "../quazal/context";
import {
  PacketFlag,
  PacketType,
  type QPacketData,
  StreamType,
  hasFlag,
  serializeQPacket,
} from "../quazal/prudp/packet";
import { fromBytes, toBytes } from "../quazal/rmc/basic";
import { parseStationUrl } from "../quazal/rmc/types";
import { parseRmcPacket, serializeRmcResponse } from "../quazal/rmc/packet";
import {
  LoginExResponse,
  LoginExRequest,
  RVConnectionData,
  TICKET_GRANTING_PROTOCOL_ID,
  TicketGrantingProtocolMethod,
  UbiAuthenticationLoginCustomData,
} from "../protocols/ticket-granting.types";
import { openAny } from "../quazal/rmc/types";
import { WriteStream, qbuffer } from "../quazal/rmc/basic";
import {
  type KerberosTicket,
  NONCE_BYTES,
  deriveKey,
  kerberosTicketInternal,
} from "../quazal/kerberos";
import { cryptKey } from "../quazal/prudp/crypto";
import { ClientInfo } from "./client-info";
import { ClientRegistry } from "./client-registry";

const log = debug("authentication");

/** Configuration knobs for deterministic replay; randomized in production. */
export interface AuthServerOptions {
  ctx?: Context;
  /** Fixed server signature; defaults to a random one. */
  serverSignature?: number;
  /** Fixed server session; defaults to a random one. */
  serverSession?: number;
  /** Fixed session key (16 bytes); defaults to random. */
  sessionKey?: Uint8Array;
  /** Fixed secretbox nonce (24 bytes); defaults to random. */
  nonce?: Uint8Array;
  /** Server principal id baked into the ticket. */
  serverPid?: number;
  /** Resolves a username to a user id; defaults to a fixed test pid. */
  resolveUser?: (username: string) => number;
  /** Builds the connection data for a logged-in user. */
  connectionData?: (serverPid: number) => RVConnectionData;
}

function randomU32(): number {
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export class AuthenticationServer {
  private newClients = new Map<number, ClientInfo>();
  private clientRegistry = new ClientRegistry();
  private ctx: Context;
  private opts: AuthServerOptions;

  constructor(
    private onSendPacket: (packet: QPacketData) => void,
    opts: AuthServerOptions = {}
  ) {
    this.opts = opts;
    this.ctx = opts.ctx ?? splinterCellBlacklistContext();
  }

  /** Must be awaited before handling packets (initializes libsodium). */
  static async ready(): Promise<void> {
    await _sodium.ready;
  }

  handlePacket(packet: QPacketData) {
    log("handling packet type %s seq %d", PacketType[packet.packetType], packet.sequence);
    if (hasFlag(packet, PacketFlag.Ack)) return;

    switch (packet.packetType) {
      case PacketType.Syn:
        this.handleSyn(packet);
        break;
      case PacketType.Connect:
        this.handleConnect(packet);
        break;
      case PacketType.Data:
        this.handleData(packet);
        break;
      default:
        console.warn("unknown packet type", PacketType[packet.packetType]);
    }
  }

  private handleSyn(packet: QPacketData) {
    const ci = new ClientInfo(this.opts.serverSignature ?? randomU32());
    const sig = ci.serverSignature;
    this.newClients.set(sig, ci);

    const ack = { ...packet, connSignature: sig };
    this.sendAck(ack, ci, false);
  }

  private handleConnect(packet: QPacketData) {
    if (packet.connSignature === undefined) {
      console.error("deny connect: no connection signature");
      return;
    }
    const ci = this.newClients.get(packet.signature);
    if (!ci) {
      console.warn("deny connect: unknown signature");
      return;
    }
    this.newClients.delete(packet.signature);

    ci.clientSignature = packet.connSignature;
    ci.serverSession = this.opts.serverSession ?? randomU32() & 0xff;
    ci.clientSession = packet.sessionId;
    this.clientRegistry.clients.set(packet.signature, ci);

    let payload = new Uint8Array(0);
    let keepPayload = false;
    if (packet.payload.length !== 0) {
      // The auth capture carries an empty Connect payload, so the secure-server
      // ticket exchange is left as a documented stub. When implemented it would:
      //   read qbuffer ticket + qbuffer requestData; open the ticket with the
      //   ticket key; RC4-decrypt requestData with the session key to recover
      //   {userPid, connectionId, challenge}; reply qbuffer(u32le(challenge+1)).
      log("connect payload present (%d bytes) — ticket exchange not implemented", packet.payload.length);
      keepPayload = false;
    }

    const ack = { ...packet, connSignature: 0, payload };
    this.sendAck(ack, ci, keepPayload);
  }

  private handleData(packet: QPacketData) {
    const ci = this.clientRegistry.clients.get(packet.signature);
    if (!ci) throw new Error("client is unknown");
    ci.lastSeen = new Date();

    // Ack the data packet first (echoes the client sequence).
    this.sendAck(packet, ci, false);

    if (packet.fragmentId !== undefined && packet.fragmentId !== 0) {
      throw new Error("packet fragmentation not implemented");
    }

    if (packet.destination.streamType !== StreamType.RVSec || packet.destination.port !== 1) {
      return;
    }

    const rmc = parseRmcPacket(packet.payload);
    if (rmc.kind !== "request") {
      throw new Error("RMC responses are not supported here");
    }
    const request = rmc.request;

    if (request.protocolId !== TICKET_GRANTING_PROTOCOL_ID) {
      throw new Error(`unknown protocol id ${request.protocolId}`);
    }
    if (request.methodId !== TicketGrantingProtocolMethod.LoginEx) {
      throw new Error(`unknown method id ${request.methodId}`);
    }

    const responseData = this.handleLoginEx(ci, request.parameters);
    const responseBytes = serializeRmcResponse({
      protocolId: request.protocolId,
      ok: { callId: request.callId, methodId: request.methodId, data: responseData },
    });

    this.sendResponse(packet, ci, responseBytes);
  }

  private handleLoginEx(ci: ClientInfo, parameters: Uint8Array): Uint8Array {
    const request = fromBytes(LoginExRequest, parameters);
    const custom = openAny(request.oExtraData, UbiAuthenticationLoginCustomData);
    log("LoginEx attempt by %s (%s)", custom.userName, request.strUserName);

    const userId = this.opts.resolveUser
      ? this.opts.resolveUser(custom.userName)
      : 1002;
    ci.userId = userId;

    const serverPid = this.opts.serverPid ?? 0x1000;
    const sessionKey = this.opts.sessionKey ?? randomBytes(16);

    const ticket: KerberosTicket = {
      sessionKey,
      pid: serverPid,
      internal: {
        principleId: userId,
        validUntil: 0xffffffffffffffffn,
        sessionKey,
      },
    };

    // libsodium's primitives are synchronous once `_sodium.ready` has resolved.
    // The server requires `AuthenticationServer.ready()` to have been awaited
    // before any packet is handled (the harness and live server both do this).
    const ticketBytes = ticketToBytesSync(ticket, userId, this.ctx.ticketKey, this.opts.nonce);

    const connectionData = this.opts.connectionData
      ? this.opts.connectionData(serverPid)
      : defaultConnectionData(serverPid);

    const response: LoginExResponse = {
      returnValue: 0x10001,
      pidPrincipal: userId,
      pbufResponse: ticketBytes,
      pConnectionData: connectionData,
      strReturnMsg: "",
    };

    return toBytes(LoginExResponse, response);
  }

  private sendAck(packet: QPacketData, ci: ClientInfo, keepPayload: boolean) {
    const resp: QPacketData = {
      ...packet,
      source: packet.destination,
      destination: packet.source,
      flags: PacketFlag.Ack | PacketFlag.HasSize,
      signature: ci.clientSignature ?? 0,
      sessionId: ci.serverSession,
      sequence: packet.sequence,
      payload: keepPayload ? packet.payload : new Uint8Array(0),
      useCompression: false,
    };
    this.sendPacket(resp);
  }

  private sendResponse(packet: QPacketData, ci: ClientInfo, payload: Uint8Array) {
    const resp: QPacketData = {
      source: packet.destination,
      destination: packet.source,
      packetType: PacketType.Data,
      flags: PacketFlag.HasSize | PacketFlag.NeedAck | PacketFlag.Reliable,
      sessionId: ci.serverSession,
      signature: ci.clientSignature ?? 0,
      sequence: ci.serverSequenceId,
      fragmentId: 0,
      connSignature: undefined,
      payload,
      checksum: 0,
      useCompression: false,
    };
    ci.serverSequenceId += 1;
    this.sendPacket(resp);
  }

  private sendPacket(packet: QPacketData) {
    if (packet.packetType === PacketType.Data) {
      packet.useCompression = true;
      if (packet.fragmentId === undefined) packet.fragmentId = 0;
    }
    packet.flags |= PacketFlag.HasSize;
    this.onSendPacket(packet);
  }

  /** Exposes the context for harness comparison. */
  get context(): Context {
    return this.ctx;
  }

  serialize(packet: QPacketData): Uint8Array {
    return serializeQPacket(this.ctx, packet);
  }
}

export function defaultConnectionData(serverPid: number): RVConnectionData {
  return {
    urlRegularProtocols: parseStationUrl(
      `prudps:/address=127.0.0.1;port=21171;CID=1;PID=${serverPid};sid=1;stream=3;type=2`
    ),
    lstSpecialProtocols: [],
    urlSpecialProtocols: parseStationUrl(":/address=;port=0"),
  };
}

// Synchronous ticket serialization. libsodium-wrappers exposes its primitives
// synchronously once `_sodium.ready` has resolved; callers must await
// `AuthenticationServer.ready()` before handling packets.
function ticketToBytesSync(
  ticket: KerberosTicket,
  peerPid: number,
  ticketKey: Uint8Array,
  nonce?: Uint8Array
): Uint8Array {
  const n = nonce ?? _sodium.randombytes_buf(NONCE_BYTES);
  const plaintext = toBytes(kerberosTicketInternal, ticket.internal);
  const sealed0 = _sodium.crypto_secretbox_easy(plaintext, n, ticketKey);
  const sealed = new Uint8Array(n.length + sealed0.length);
  sealed.set(n);
  sealed.set(sealed0, n.length);

  const inner = new WriteStream();
  inner.bytes(ticket.sessionKey).u32(ticket.pid);
  inner.write(qbuffer, sealed);
  const innerBytes = inner.toBytes();

  const derived = deriveKey(peerPid);
  const ciphertext = cryptKey(derived, innerBytes);
  const mac = crypto.createHmac("md5", derived).update(ciphertext).digest();

  const out = new Uint8Array(ciphertext.length + mac.length);
  out.set(ciphertext);
  out.set(mac, ciphertext.length);
  return out;
}
