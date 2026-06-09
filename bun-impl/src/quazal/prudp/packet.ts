// PRUDP packet parsing/serialization — port of quazal/src/prudp/packet.rs.
import { deflateSync, inflateSync } from "node:zlib";
import { type Context, checksumKey } from "../context";
import { cryptKey } from "./crypto";

export enum StreamType {
  DO = 1,
  RV = 2,
  RVSec = 3,
  SBMGMT = 4,
  NAT = 5,
  SessionDiscovery = 6,
  NATEcho = 7,
  Routing = 8,
}

export enum PacketType {
  Syn = 0,
  Connect = 1,
  Data = 2,
  Disconnect = 3,
  Ping = 4,
  User = 5,
  Route = 6,
  Raw = 7,
}

export enum PacketFlag {
  Ack = 0b0001,
  Reliable = 0b0010,
  NeedAck = 0b0100,
  HasSize = 0b1000,
}

export interface VPort {
  port: number;
  streamType: StreamType;
}

/** VPort wire format: one byte, `port | (streamType << 4)`. */
export function vportToByte(v: VPort): number {
  return (v.port | (v.streamType << 4)) & 0xff;
}

export function vportFromByte(val: number): VPort {
  const streamType = val >> 4;
  if (StreamType[streamType] === undefined) {
    throw new Error(`Invalid stream type ${streamType}`);
  }
  return { port: val & 0xf, streamType };
}

export interface QPacketData {
  source: VPort;
  destination: VPort;
  packetType: PacketType;
  /** Bitwise OR of PacketFlag values. */
  flags: number;
  sessionId: number;
  signature: number;
  /** Only present on Data packets. */
  fragmentId?: number;
  /** Only present on Syn/Connect packets. */
  connSignature?: number;
  sequence: number;
  /** Decrypted, decompressed payload. */
  payload: Uint8Array;
  checksum: number;
  useCompression: boolean;
}

export function hasFlag(packet: { flags: number }, flag: PacketFlag): boolean {
  return (packet.flags & flag) !== 0;
}

/**
 * Parses one packet starting at `offset`. Returns the packet and the number of
 * bytes consumed (including the trailing checksum byte).
 */
export function parseQPacket(
  ctx: Context,
  data: Uint8Array,
  offset = 0
): { packet: QPacketData; bytesRead: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = offset;
  const need = (n: number) => {
    if (pos + n > data.length) throw new Error("packet truncated");
  };

  need(4);
  const source = vportFromByte(view.getUint8(pos++));
  const destination = vportFromByte(view.getUint8(pos++));
  const typeFlag = view.getUint8(pos++);
  const packetType = (typeFlag & 0x7) as PacketType;
  if (PacketType[packetType] === undefined) {
    throw new Error(`Invalid packet type ${packetType}`);
  }
  const flags = typeFlag >> 3;
  const sessionId = view.getUint8(pos++);
  need(6);
  const signature = view.getUint32(pos, true);
  pos += 4;
  const sequence = view.getUint16(pos, true);
  pos += 2;

  let connSignature: number | undefined;
  if (packetType === PacketType.Syn || packetType === PacketType.Connect) {
    need(4);
    connSignature = view.getUint32(pos, true);
    pos += 4;
  }

  let fragmentId: number | undefined;
  if (packetType === PacketType.Data) {
    need(1);
    fragmentId = view.getUint8(pos++);
  }

  let payloadSize: number;
  if ((flags & PacketFlag.HasSize) !== 0) {
    need(2);
    payloadSize = view.getUint16(pos, true);
    pos += 2;
  } else {
    payloadSize = data.length - pos - 1;
  }

  need(payloadSize);
  let payload = data.slice(pos, pos + payloadSize);
  pos += payloadSize;

  let useCompression = false;
  if (packetType !== PacketType.Syn && source.streamType === StreamType.RVSec) {
    payload = cryptKey(ctx.cryptoKey, payload);
    useCompression = payload.length > 0 && payload[0] !== 0;
    if (useCompression) {
      payload = Uint8Array.from(inflateSync(payload.subarray(1)));
    } else if (payload.length > 0) {
      payload = payload.slice(1);
    }
  }

  need(1);
  const checksum = view.getUint8(pos++);

  return {
    packet: {
      source,
      destination,
      packetType,
      flags,
      sessionId,
      signature,
      fragmentId,
      connSignature,
      sequence,
      payload,
      checksum,
      useCompression,
    },
    bytesRead: pos - offset,
  };
}

/** Serializes everything except the trailing checksum byte. */
export function serializeQPacketData(ctx: Context, packet: QPacketData): Uint8Array {
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  let pos = 0;
  view.setUint8(pos++, vportToByte(packet.source));
  view.setUint8(pos++, vportToByte(packet.destination));
  view.setUint8(pos++, (packet.packetType | (packet.flags << 3)) & 0xff);
  view.setUint8(pos++, packet.sessionId & 0xff);
  view.setUint32(pos, packet.signature >>> 0, true);
  pos += 4;
  view.setUint16(pos, packet.sequence & 0xffff, true);
  pos += 2;

  const parts: Uint8Array[] = [head.subarray(0, pos)];

  if (packet.packetType === PacketType.Syn || packet.packetType === PacketType.Connect) {
    if (packet.connSignature === undefined) {
      throw new Error("connection signature required");
    }
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, packet.connSignature >>> 0, true);
    parts.push(buf);
  } else if (packet.packetType === PacketType.Data) {
    if (packet.fragmentId === undefined) {
      throw new Error("fragment id required");
    }
    parts.push(Uint8Array.of(packet.fragmentId & 0xff));
  }

  let payload: Uint8Array;
  if (packet.payload.length === 0) {
    payload = new Uint8Array(0);
  } else if (packet.useCompression) {
    const compressed = Uint8Array.from(deflateSync(packet.payload, { level: 6 }));
    payload = new Uint8Array(compressed.length + 1);
    payload[0] = (Math.floor(packet.payload.length / compressed.length) + 1) & 0xff;
    payload.set(compressed, 1);
  } else {
    payload = new Uint8Array(packet.payload.length + 1);
    payload[0] = 0;
    payload.set(packet.payload, 1);
  }

  if (packet.packetType !== PacketType.Syn && packet.source.streamType === StreamType.RVSec) {
    payload = cryptKey(ctx.cryptoKey, payload);
  }

  if ((packet.flags & PacketFlag.HasSize) !== 0) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, payload.length & 0xffff, true);
    parts.push(buf);
  }

  parts.push(payload);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Serializes a packet including the trailing checksum byte. */
export function serializeQPacket(ctx: Context, packet: QPacketData): Uint8Array {
  const data = serializeQPacketData(ctx, packet);
  const out = new Uint8Array(data.length + 1);
  out.set(data);
  out[data.length] = calcChecksumFromData(checksumKey(ctx, packet.destination.streamType), data);
  return out;
}

export function calcChecksum(ctx: Context, packet: QPacketData): number {
  return calcChecksumFromData(
    checksumKey(ctx, packet.destination.streamType),
    serializeQPacketData(ctx, packet)
  );
}

/** Validates a parsed packet against its raw bytes (excluding the checksum byte). */
export function validateQPacket(ctx: Context, packet: QPacketData, rawData: Uint8Array): void {
  const expected = calcChecksumFromData(
    checksumKey(ctx, packet.destination.streamType),
    rawData.subarray(0, rawData.length - 1)
  );
  if (expected !== packet.checksum) {
    throw new Error(`Invalid checksum: packet has ${packet.checksum}, calculated ${expected}`);
  }
}

/**
 * Sums u32 LE chunks (wrapping), folds that sum's bytes, then adds the trailing
 * bytes and the key byte — all wrapping u8.
 */
export function calcChecksumFromData(key: number, data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const aligned = data.length - (data.length % 4);

  let sum = 0;
  for (let i = 0; i < aligned; i += 4) {
    sum = (sum + view.getUint32(i, true)) >>> 0;
  }

  let dataSum = 0;
  for (let i = 0; i < 4; i++) {
    dataSum += (sum >>> (i * 8)) & 0xff;
  }

  let trailerSum = 0;
  for (let i = aligned; i < data.length; i++) {
    trailerSum += data[i];
  }

  return (dataSum + (key & 0xff) + trailerSum) & 0xff;
}
