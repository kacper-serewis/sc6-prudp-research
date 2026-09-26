/**
 * A PRUDP/RMC client that behaves like the game, for end-to-end tests against the
 * TypeScript server and the Rust reference server.
 */
import type { udp } from "bun";
import { randomInt } from "node:crypto";
import { LoginExRequest, LoginExResponse } from "../src/protocols/authentication-foundation/ticket-granting-protocol";
import { UbiAuthenticationLoginCustomData } from "../src/protocols/ubi-authentication/types";
import { buffer, decode, encode, struct, u32, type Codec } from "../src/quazal/codec";
import type { Context, SocketAddress } from "../src/quazal/context";
import { decodeKerberosTicket } from "../src/quazal/kerberos";
import { PacketFlag, PacketType, QPacket, StreamType } from "../src/quazal/prudp/packet";
import { cryptKey } from "../src/quazal/rc4";
import { encodeRmcRequest, parseRmcPacket, type RmcRequest, type RmcResponse } from "../src/quazal/rmc/message";
import type { MethodDefinition, ProtocolDefinition } from "../src/quazal/rmc/protocol";

const CLIENT_PORT = { port: 15, streamType: StreamType.RVSec };
const SERVER_PORT = { port: 1, streamType: StreamType.RVSec };
const TIMEOUT_MS = 5000;

export class RmcCallError extends Error {
  constructor(readonly errorCode: number) {
    super(`RMC error 0x${errorCode.toString(16)}`);
  }
}

export class QuazalClient {
  private readonly received: QPacket[] = [];
  private readonly waiters: (() => void)[] = [];
  private socket!: udp.Socket<"buffer">;
  private sequence = 1;
  private callId = 1;
  /** Signature the server assigned in the SYN-ACK, sent with every packet. */
  signature = 0;
  readonly sessionId = randomInt(256);
  readonly connSignature = randomInt(1, 0x1_0000_0000);
  /** Requests the server sent to us (e.g. NAT probes). */
  readonly serverRequests: RmcRequest[] = [];
  /** Raw datagrams that were not PRUDP packets for us. */
  readonly rawDatagrams: Buffer[] = [];

  private constructor(
    readonly ctx: Context,
    readonly server: SocketAddress,
  ) {}

  static async open(ctx: Context, server: SocketAddress) {
    const client = new QuazalClient(ctx, server);
    client.socket = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: { data: (_s, data) => client.onDatagram(Buffer.from(data)) },
    });
    return client;
  }

  get localAddress(): SocketAddress {
    return { host: "127.0.0.1", port: this.socket.port };
  }

  private onDatagram(data: Buffer) {
    try {
      let offset = 0;
      while (offset < data.length) {
        const { packet, size } = QPacket.fromBytes(this.ctx, data.subarray(offset));
        packet.validate(this.ctx, data.subarray(offset, offset + size));
        offset += size;
        this.received.push(packet);
      }
    } catch {
      this.rawDatagrams.push(data);
    }
    this.waiters.splice(0).forEach((wake) => wake());
  }

  /** Waits for (and removes) the first received packet matching `predicate`. */
  async receive(predicate: (p: QPacket) => boolean, timeoutMs = TIMEOUT_MS): Promise<QPacket> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.received.findIndex(predicate);
      if (index >= 0) {
        return this.received.splice(index, 1)[0];
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out waiting for a packet");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Waits for a raw (non-PRUDP) datagram. */
  async receiveRaw(timeoutMs = TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.rawDatagrams.length === 0) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for a raw datagram");
      }
      await Bun.sleep(5);
    }
    return this.rawDatagrams.shift()!;
  }

  sendPacket(packet: QPacket) {
    this.socket.send(packet.toBytes(this.ctx), this.server.port, this.server.host);
  }

  sendRaw(data: Buffer) {
    this.socket.send(data, this.server.port, this.server.host);
  }

  private packet(init: Partial<QPacket>) {
    return new QPacket({
      source: CLIENT_PORT,
      destination: SERVER_PORT,
      sessionId: this.sessionId,
      signature: this.signature,
      ...init,
    });
  }

  async syn(timeoutMs = TIMEOUT_MS) {
    this.sendPacket(this.packet({ packetType: PacketType.Syn, flags: PacketFlag.NeedAck, connSignature: 0, signature: 0 }));
    const ack = await this.receive((p) => p.packetType === PacketType.Syn && p.hasFlag(PacketFlag.Ack), timeoutMs);
    this.signature = ack.connSignature!;
    return ack;
  }

  async connect(payload = Buffer.alloc(0)) {
    this.sendPacket(
      this.packet({
        packetType: PacketType.Connect,
        flags: PacketFlag.Reliable | PacketFlag.NeedAck | PacketFlag.HasSize,
        connSignature: this.connSignature,
        sequence: this.sequence++,
        payload,
      }),
    );
    return this.receive((p) => p.packetType === PacketType.Connect && p.hasFlag(PacketFlag.Ack));
  }

  /** SYN + CONNECT with a Kerberos ticket, like the game does for the secure server. */
  async connectWithTicket(sealedInternal: Buffer, sessionKey: Buffer, userPid: number, challenge = randomInt(0, 0xffffffff)) {
    await this.syn();
    const requestData = cryptKey(
      sessionKey,
      encode(struct({ userPid: u32, connectionId: u32, challenge: u32 }), { userPid, connectionId: 1, challenge }),
    );
    const ack = await this.connect(Buffer.concat([encode(buffer, sealedInternal), encode(buffer, requestData)]));
    return { ack, challenge };
  }

  /** Sends DATA packets (fragmented like the game: 1, 2, ..., then 0 for the last one). */
  sendData(payload: Buffer, fragmentSize = 1000) {
    const count = Math.max(1, Math.ceil(payload.length / fragmentSize));
    for (let i = 0; i < count; i++) {
      this.sendPacket(
        this.packet({
          packetType: PacketType.Data,
          flags: PacketFlag.Reliable | PacketFlag.NeedAck | PacketFlag.HasSize,
          sequence: this.sequence++,
          fragmentId: i === count - 1 ? 0 : i + 1,
          payload: payload.subarray(i * fragmentSize, (i + 1) * fragmentSize),
        }),
      );
    }
  }

  /** Receives the next complete RMC message (reassembling fragments). */
  async receiveRmc(timeoutMs = TIMEOUT_MS) {
    const parts: Buffer[] = [];
    for (;;) {
      const packet = await this.receive((p) => p.packetType === PacketType.Data && !p.hasFlag(PacketFlag.Ack), timeoutMs);
      parts.push(packet.payload);
      if (packet.fragmentId === 0) {
        return Buffer.concat(parts);
      }
    }
  }

  /** Performs a raw RMC call and returns the response (successful or not). */
  async callRaw(protocolId: number, methodId: number, parameters: Buffer, fragmentSize?: number): Promise<RmcResponse> {
    const callId = this.callId++;
    this.sendData(encodeRmcRequest({ protocolId, callId, methodId, parameters }), fragmentSize);
    for (;;) {
      const message = parseRmcPacket(await this.receiveRmc());
      if (message.type === "request") {
        this.serverRequests.push(message.request);
        continue;
      }
      if (message.response.result.callId !== callId) {
        throw new Error(`unexpected call id ${message.response.result.callId}, expected ${callId}`);
      }
      return message.response;
    }
  }

  /** Calls a generated protocol method and decodes its response, throwing on RMC errors. */
  async call<Req, Res>(protocol: ProtocolDefinition, method: MethodDefinition<Req, Res>, request: Req): Promise<Res> {
    const response = await this.callRaw(protocol.id!, method.id, encode(method.request as Codec<Req>, request));
    if (!response.result.ok) {
      throw new RmcCallError(response.result.errorCode);
    }
    return decode(method.response, response.result.data);
  }

  async ping() {
    this.sendPacket(this.packet({ packetType: PacketType.Ping, flags: PacketFlag.NeedAck, sequence: this.sequence++ }));
    return this.receive((p) => p.packetType === PacketType.Ping && p.hasFlag(PacketFlag.Ack));
  }

  async disconnect() {
    this.sendPacket(this.packet({ packetType: PacketType.Disconnect, flags: PacketFlag.NeedAck, sequence: this.sequence++ }));
    return this.receive((p) => p.packetType === PacketType.Disconnect && p.hasFlag(PacketFlag.Ack));
  }

  close() {
    this.socket.close();
  }
}

/** Builds LoginEx parameters like the game. */
export function loginExParameters(username: string, password: string) {
  return {
    strUserName: username,
    oExtraData: {
      typeName: "UbiAuthenticationLoginCustomData",
      data: encode(UbiAuthenticationLoginCustomData, { userName: username, onlineKey: "AAAA-BBBB-CCCC", password }),
    },
  } satisfies LoginExRequest;
}

/** Logs in on an authentication server and decrypts the returned ticket. */
export function openLoginTicket(response: LoginExResponse, password?: string) {
  return decodeKerberosTicket(response.pbufResponse, response.pidPrincipal, password);
}
