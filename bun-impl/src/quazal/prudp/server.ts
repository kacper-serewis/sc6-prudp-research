/**
 * PRUDP server (port of `quazal::prudp::Server`).
 *
 * Handles the SYN/CONNECT handshake, acknowledges packets, reassembles fragmented
 * DATA packets, and forwards their payload to the stream handler registered for the
 * destination virtual port. Like the Rust server it never retransmits: reliable
 * packets are sent once and client ACKs are ignored.
 */
import { randomInt } from "node:crypto";
import type { Logger } from "../../logger";
import { ClientInfo } from "../client-info";
import { buffer, decode, encode, struct, u32 } from "../codec";
import { formatSocketAddress, type Context, type SocketAddress } from "../context";
import { openTicketInternal } from "../kerberos";
import { cryptKey } from "../rc4";
import { ReadStream } from "../stream";
import { formatVPort, PacketFlag, PacketType, QPacket, vportToByte, type VPort } from "./packet";

export const MAX_PAYLOAD_SIZE = 1000;
export const SESSION_TIMEOUT_MS = 60_000;
const FIRST_CONNECTION_ID = 0x3aaa_aaaa;

/** Everything a stream handler (and RMC protocol) gets to see about a request. */
export interface StreamCall {
  logger: Logger;
  ctx: Context;
  client: ClientInfo;
  server: PrudpServer;
}

export interface StreamHandler {
  /** Returns the response payload. Throwing means that no response is sent. */
  handle(call: StreamCall, data: Buffer): Buffer;
}

export interface Transport {
  send(data: Buffer, to: SocketAddress): void;
  close(): void;
}

export type UserPacketHandler = (logger: Logger, packet: QPacket, from: SocketAddress, server: PrudpServer) => void;

/** Sent by clients in the CONNECT payload, encrypted with the session key of their ticket. */
const ConnectData = struct({ userPid: u32, connectionId: u32, challenge: u32 });

export class PrudpServer {
  private readonly handlers = new Map<number, StreamHandler>();
  /** Clients that sent a SYN but no CONNECT yet, by server signature. */
  private readonly newClients = new Map<number, ClientInfo>();
  /** Connected clients by server signature. */
  readonly clients = new Map<number, ClientInfo>();
  private readonly connectionIds = new Map<number, number>();
  private nextConnectionId = FIRST_CONNECTION_ID;
  private transport?: Transport;
  private expiryTimer?: ReturnType<typeof setInterval>;

  onExpiredClient?: (client: ClientInfo) => void;
  onDisconnect?: (client: ClientInfo) => void;
  userHandler?: UserPacketHandler;

  constructor(
    readonly logger: Logger,
    readonly ctx: Context,
  ) {}

  register(vport: VPort, handler: StreamHandler) {
    this.logger.debug(`Registering handler for ${formatVPort(vport)}`);
    this.handlers.set(vportToByte(vport), handler);
  }

  /** Binds the UDP socket to `ctx.listen`. */
  async listen(): Promise<SocketAddress> {
    const socket = await Bun.udpSocket({
      hostname: this.ctx.listen.host,
      port: this.ctx.listen.port,
      socket: {
        data: (_socket, data, port, address) => this.handleDatagram(data, { host: address, port }),
      },
    });
    this.attach({
      send: (data, to) => void socket.send(data, to.port, to.host),
      close: () => socket.close(),
    });
    const bound = { host: socket.address.address, port: socket.address.port };
    this.logger.info(`Listening on ${formatSocketAddress(bound)}`);
    return bound;
  }

  /** Uses `transport` for outgoing packets and starts expiring idle clients. */
  attach(transport: Transport) {
    this.transport = transport;
    clearInterval(this.expiryTimer);
    this.expiryTimer = setInterval(() => this.clearExpiredClients(), 1000);
  }

  close() {
    clearInterval(this.expiryTimer);
    this.transport?.close();
    this.transport = undefined;
  }

  clientByConnectionId(connectionId: number) {
    const signature = this.connectionIds.get(connectionId);
    return signature === undefined ? undefined : this.clients.get(signature);
  }

  /** Processes a UDP datagram, which may contain several packets. */
  handleDatagram(data: Buffer, from: SocketAddress) {
    const logger = this.logger.child({ client: formatSocketAddress(from) });
    let offset = 0;
    while (offset < data.length) {
      let packet: QPacket;
      let size: number;
      try {
        ({ packet, size } = QPacket.fromBytes(this.ctx, data.subarray(offset)));
      } catch (e) {
        logger.error("Invalid packet received", { error: (e as Error).message });
        return;
      }
      const raw = data.subarray(offset, offset + size);
      offset += size;
      logger.trace(`-> ${raw.toString("hex")}`);

      try {
        packet.validate(this.ctx, raw);
      } catch (e) {
        logger.error(`Invalid packet received: ${packet}`, { error: (e as Error).message });
        continue;
      }

      try {
        this.handlePacket(logger.child({ seq: packet.sequence, session: packet.sessionId }), packet, from);
      } catch (e) {
        logger.error("Error handling packet", { error: e });
      }
    }
  }

  private handlePacket(logger: Logger, packet: QPacket, from: SocketAddress) {
    logger.debug(`packet: ${packet}`);
    if (packet.hasFlag(PacketFlag.Ack)) {
      logger.debug("Received ACK");
      return;
    }
    switch (packet.packetType) {
      case PacketType.Syn:
        return this.handleSyn(logger, packet, from);
      case PacketType.Connect:
        return this.handleConnect(logger, packet, from);
      case PacketType.Data:
        return this.handleData(logger, packet, from);
      case PacketType.Disconnect: {
        const client = this.clients.get(packet.signature);
        if (!client) {
          return;
        }
        this.removeClient(packet.signature, client);
        logger.info("Client disconnected", { signature: packet.signature, session: packet.sessionId });
        this.sendAck(logger, from, packet, client, false);
        this.onDisconnect?.(client);
        return;
      }
      case PacketType.Ping: {
        const client = this.clients.get(packet.signature);
        if (!client) {
          return;
        }
        client.seen();
        this.sendAck(logger, from, packet, client, false);
        return;
      }
      case PacketType.User:
        if (this.userHandler) {
          this.userHandler(logger, packet, from, this);
        } else {
          logger.error("unsupported user packet");
        }
        return;
      default:
        logger.error(`unsupported packet type ${PacketType[packet.packetType]}`);
    }
  }

  private handleSyn(logger: Logger, packet: QPacket, from: SocketAddress) {
    logger.debug("Handling syn packet");
    const client = new ClientInfo(from);
    this.newClients.set(client.serverSignature, client);
    packet.connSignature = client.serverSignature;
    this.sendAck(logger, from, packet, client, false);
  }

  private handleConnect(logger: Logger, packet: QPacket, from: SocketAddress) {
    logger.debug("Handling connect packet");
    const clientSignature = packet.connSignature;
    if (clientSignature === undefined) {
      logger.error(`Client ${packet.signature} did not provide a connection signature`);
      return;
    }
    const client = this.newClients.get(packet.signature);
    if (!client) {
      logger.warn(`Unknown client ${packet.signature.toString(16)} tried to connect. Ignoring the attempt`);
      return;
    }
    this.newClients.delete(packet.signature);
    client.clientSignature = clientSignature;
    client.serverSession = randomInt(256);
    client.clientSession = packet.sessionId;
    this.clients.set(packet.signature, client);

    if (packet.payload.length > 0) {
      const data = packet.payload;
      packet.payload = Buffer.alloc(0);
      try {
        packet.payload = this.acceptTicket(client, packet.signature, data);
      } catch (e) {
        logger.error("Error parsing ticket", { error: (e as Error).message });
      }
    }

    packet.connSignature = 0;
    this.sendAck(logger, from, packet, client, packet.payload.length > 0);
    logger.info("New client connected", { signature: packet.signature, session: packet.sessionId });
  }

  /**
   * Validates the Kerberos ticket a client presents to the secure server and answers
   * its challenge, which proves that we could decrypt the session key.
   */
  private acceptTicket(client: ClientInfo, signature: number, data: Buffer) {
    const s = new ReadStream(data);
    const ticket = buffer.read(s);
    const requestData = buffer.read(s);

    const internal = openTicketInternal(ticket, this.ctx.ticketKey);
    if (internal.validUntil < BigInt(Math.floor(Date.now() / 1000))) {
      return Buffer.alloc(0);
    }
    const connectionId = this.nextConnectionId;
    this.nextConnectionId = (this.nextConnectionId + 1) >>> 0;
    client.userId = internal.principleId;
    client.connectionId = connectionId;
    this.connectionIds.set(connectionId, signature);

    const connectData = decode(ConnectData, cryptKey(internal.sessionKey, requestData));
    return encode(buffer, encode(u32, (connectData.challenge + 1) >>> 0));
  }

  private handleData(logger: Logger, packet: QPacket, from: SocketAddress) {
    logger.debug("Handling data packet");
    const client = this.clients.get(packet.signature);
    if (!client) {
      logger.warn("client is unknown!");
      return;
    }
    logger = logger.child({ pid: client.userId });
    client.seen();
    this.sendAck(logger, from, packet, client, false);

    let payload = packet.payload;
    if (packet.fragmentId !== undefined) {
      if (packet.fragmentId !== 0) {
        logger.info(`Caching fragment ${packet.fragmentId}`);
        client.packetFragments.set(packet.fragmentId, packet.payload);
        return;
      }
      if (client.packetFragments.size > 0) {
        const parts: Buffer[] = [];
        for (let fid = 1; fid <= client.packetFragments.size; fid++) {
          const fragment = client.packetFragments.get(fid);
          if (!fragment) {
            logger.error(`missing fragment ${fid}`);
            client.packetFragments.clear();
            return;
          }
          parts.push(fragment);
        }
        logger.info(`Reassembled ${client.packetFragments.size + 1} fragments`);
        client.packetFragments.clear();
        payload = Buffer.concat([...parts, packet.payload]);
      }
    }

    const handler = this.handlers.get(vportToByte(packet.destination));
    if (!handler) {
      logger.error("No handler found");
      return;
    }
    let response: Buffer;
    try {
      response = handler.handle({ logger, ctx: this.ctx, client, server: this }, payload);
    } catch (e) {
      logger.error("Handler failed", { error: e });
      return;
    }

    // Fragments are numbered down to 0, which marks the last one.
    const count = Math.ceil(response.length / MAX_PAYLOAD_SIZE);
    for (let i = 0; i < count; i++) {
      const chunk = response.subarray(i * MAX_PAYLOAD_SIZE, (i + 1) * MAX_PAYLOAD_SIZE);
      this.sendResponse(
        logger,
        from,
        new QPacket({
          source: packet.destination,
          destination: packet.source,
          packetType: PacketType.Data,
          payload: chunk,
          fragmentId: count - 1 - i,
        }),
        client,
      );
    }
  }

  private sendResponse(logger: Logger, to: SocketAddress, packet: QPacket, client: ClientInfo) {
    packet.sequence = client.serverSequenceId;
    client.serverSequenceId = (client.serverSequenceId + 1) & 0xffff;
    packet.flags |= PacketFlag.HasSize | PacketFlag.NeedAck | PacketFlag.Reliable;
    packet.signature = client.clientSignature ?? 0;
    packet.sessionId = client.serverSession;
    this.sendPacket(logger, to, packet);
  }

  /** Sends a server initiated packet (e.g. an RMC request) to a connected client. */
  sendRequest(logger: Logger, client: ClientInfo, packet: QPacket) {
    packet.sequence = client.clientSequenceId;
    client.clientSequenceId = (client.clientSequenceId + 1) & 0xffff;
    packet.flags |= PacketFlag.HasSize | PacketFlag.NeedAck | PacketFlag.Reliable;
    packet.signature = client.serverSignature;
    packet.sessionId = client.clientSession;
    this.sendPacket(logger, client.address, packet);
  }

  private sendAck(logger: Logger, to: SocketAddress, packet: QPacket, client: ClientInfo, keepPayload: boolean) {
    const ack = packet.clone();
    ack.source = packet.destination;
    ack.destination = packet.source;
    ack.flags = PacketFlag.Ack | PacketFlag.HasSize;
    ack.signature = client.clientSignature ?? 0;
    ack.sessionId = client.serverSession;
    if (!keepPayload) {
      ack.payload = Buffer.alloc(0);
    }
    ack.sequence = packet.sequence;
    this.sendPacket(logger, to, ack);
  }

  /** Sends raw bytes, bypassing PRUDP. */
  sendRaw(data: Buffer, to: SocketAddress) {
    if (!this.transport) {
      throw new Error("server is not listening");
    }
    this.transport.send(data, to);
  }

  private sendPacket(logger: Logger, to: SocketAddress, packet: QPacket) {
    if (packet.packetType === PacketType.Data) {
      packet.useCompression = true;
      packet.fragmentId ??= 0;
    }
    packet.flags |= PacketFlag.HasSize;
    logger.trace(`<- ${packet}`);
    const data = packet.toBytes(this.ctx);
    logger.trace(`<- ${data.toString("hex")}`);
    this.sendRaw(data, to);
  }

  private removeClient(signature: number, client: ClientInfo) {
    this.clients.delete(signature);
    if (client.connectionId !== undefined) {
      this.connectionIds.delete(client.connectionId);
    }
  }

  /** Drops clients that were silent for longer than `SESSION_TIMEOUT_MS`. */
  clearExpiredClients(now = Date.now()) {
    for (const [signature, client] of this.clients) {
      if (now - client.lastSeen > SESSION_TIMEOUT_MS) {
        this.removeClient(signature, client);
        this.logger.info("Client session expired", { client: formatSocketAddress(client.address), pid: client.userId });
        this.onExpiredClient?.(client);
      }
    }
    for (const [signature, client] of this.newClients) {
      if (now - client.lastSeen > SESSION_TIMEOUT_MS) {
        this.newClients.delete(signature);
      }
    }
  }
}
