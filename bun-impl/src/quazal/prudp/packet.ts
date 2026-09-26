/**
 * PRUDP packets (port of `quazal::prudp::packet`).
 *
 * Layout (all integers little-endian):
 *
 * | field          | size | notes                                     |
 * |----------------|------|-------------------------------------------|
 * | source         | 1    | `port \| stream_type << 4`                |
 * | destination    | 1    |                                           |
 * | type and flags | 1    | `type \| flags << 3`                      |
 * | session id     | 1    |                                           |
 * | signature      | 4    |                                           |
 * | sequence       | 2    |                                           |
 * | conn signature | 4    | SYN and CONNECT only                      |
 * | fragment id    | 1    | DATA only                                 |
 * | payload size   | 2    | only with the HasSize flag                |
 * | payload        | n    | RC4 encrypted for RVSec (except SYN)      |
 * | checksum       | 1    |                                           |
 */
import { deflateSync, inflateSync } from "node:zlib";
import { checksumKey, type Context } from "../context";
import { cryptKey } from "../rc4";
import { StreamType } from "./stream-type";

export { StreamType };

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

export const PacketFlag = {
  Ack: 1,
  Reliable: 2,
  NeedAck: 4,
  HasSize: 8,
} as const;

/**
 * Upper bound for a decompressed payload. Payloads are split into ~1000 byte fragments before
 * compression, so this only rejects decompression bombs.
 */
export const MAX_DECOMPRESSED_SIZE = 64 * 1024;

export class PacketError extends Error {
  override name = "PacketError";
}

export interface VPort {
  port: number;
  streamType: StreamType;
}

export function vportToByte(vport: VPort) {
  return (vport.port & 0xf) | (vport.streamType << 4);
}

function vportFromByte(value: number): VPort {
  const streamType = value >> 4;
  if (StreamType[streamType] === undefined) {
    throw new PacketError(`Invalid Stream Type ${streamType}`);
  }
  return { port: value & 0xf, streamType };
}

export function formatVPort(vport: VPort) {
  return `${StreamType[vport.streamType]}:${vport.port}`;
}

export function formatFlags(flags: number) {
  const names = Object.entries(PacketFlag)
    .filter(([, bit]) => flags & bit)
    .map(([name]) => name);
  return names.length ? names.join("|") : "-";
}

export class QPacket {
  source: VPort = { port: 0, streamType: StreamType.DO };
  destination: VPort = { port: 0, streamType: StreamType.DO };
  packetType = PacketType.Syn;
  flags = 0;
  sessionId = 0;
  signature = 0;
  /** DATA packets only. */
  fragmentId?: number;
  /** SYN and CONNECT packets only. */
  connSignature?: number;
  sequence = 0;
  payload: Buffer = Buffer.alloc(0);
  checksum = 0;
  useCompression = false;

  constructor(init: Partial<QPacket> = {}) {
    Object.assign(this, init);
  }

  hasFlag(flag: number) {
    return (this.flags & flag) !== 0;
  }

  clone() {
    return new QPacket({
      ...this,
      source: { ...this.source },
      destination: { ...this.destination },
      payload: Buffer.from(this.payload),
    });
  }

  /** Parses a single packet from the start of `data` and returns it with the amount of consumed bytes. */
  static fromBytes(ctx: Context, data: Buffer): { packet: QPacket; size: number } {
    let offset = 0;
    const need = (n: number) => {
      if (offset + n > data.length) {
        throw new PacketError(`I/O error: packet truncated (${data.length} bytes)`);
      }
      const start = offset;
      offset += n;
      return start;
    };

    const packet = new QPacket();
    packet.source = vportFromByte(data[need(1)]);
    packet.destination = vportFromByte(data[need(1)]);
    const typeFlag = data[need(1)];
    packet.packetType = typeFlag & 0x7;
    packet.flags = typeFlag >> 3;
    if (packet.flags & ~0xf) {
      throw new PacketError(`Invalid Flag ${packet.flags & ~0xf}`);
    }
    packet.sessionId = data[need(1)];
    packet.signature = data.readUInt32LE(need(4));
    packet.sequence = data.readUInt16LE(need(2));

    if (packet.packetType === PacketType.Syn || packet.packetType === PacketType.Connect) {
      packet.connSignature = data.readUInt32LE(need(4));
    }
    if (packet.packetType === PacketType.Data) {
      packet.fragmentId = data[need(1)];
    }

    const payloadSize = packet.hasFlag(PacketFlag.HasSize) ? data.readUInt16LE(need(2)) : data.length - offset - 1;
    if (payloadSize < 0) {
      throw new PacketError("I/O error: packet truncated");
    }
    const payloadStart = need(payloadSize);
    let payload = Buffer.from(data.subarray(payloadStart, payloadStart + payloadSize));

    if (packet.packetType !== PacketType.Syn && packet.source.streamType === StreamType.RVSec) {
      payload = cryptKey(ctx.cryptoKey, payload);
      packet.useCompression = payload.length > 0 && payload[0] !== 0;
      if (packet.useCompression) {
        try {
          payload = inflateSync(payload.subarray(1), { maxOutputLength: MAX_DECOMPRESSED_SIZE });
        } catch (e) {
          throw new PacketError(`Decompression failed ${(e as Error).message}`);
        }
      } else if (payload.length > 0) {
        payload = payload.subarray(1);
      }
    }
    packet.payload = payload;
    packet.checksum = data[need(1)];

    return { packet, size: offset };
  }

  /** Serializes everything except the checksum. */
  private toDataBytes(ctx: Context) {
    const header: number[] = [
      vportToByte(this.source),
      vportToByte(this.destination),
      (this.packetType | (this.flags << 3)) & 0xff,
      this.sessionId & 0xff,
    ];
    const fixed = Buffer.alloc(6);
    fixed.writeUInt32LE(this.signature >>> 0, 0);
    fixed.writeUInt16LE(this.sequence & 0xffff, 4);

    let specific = Buffer.alloc(0);
    if (this.packetType === PacketType.Syn || this.packetType === PacketType.Connect) {
      if (this.connSignature === undefined) {
        throw new PacketError("connection signature required");
      }
      specific = Buffer.alloc(4);
      specific.writeUInt32LE(this.connSignature >>> 0);
    } else if (this.packetType === PacketType.Data) {
      if (this.fragmentId === undefined) {
        throw new PacketError("fragment id required");
      }
      specific = Buffer.from([this.fragmentId]);
    }

    let payload: Buffer;
    if (this.payload.length === 0) {
      payload = Buffer.alloc(0);
    } else if (this.useCompression) {
      const compressed = deflateSync(this.payload, { level: 6 });
      const ratio = (Math.floor(this.payload.length / compressed.length) + 1) & 0xff;
      payload = Buffer.concat([Buffer.from([ratio]), compressed]);
    } else {
      payload = Buffer.concat([Buffer.from([0]), this.payload]);
    }

    if (this.packetType !== PacketType.Syn && this.source.streamType === StreamType.RVSec) {
      payload = cryptKey(ctx.cryptoKey, payload);
    }

    let size = Buffer.alloc(0);
    if (this.hasFlag(PacketFlag.HasSize)) {
      size = Buffer.alloc(2);
      size.writeUInt16LE(payload.length);
    }

    return Buffer.concat([Buffer.from(header), fixed, specific, size, payload]);
  }

  toBytes(ctx: Context) {
    const data = this.toDataBytes(ctx);
    const checksum = calcChecksum(checksumKey(ctx, this.destination.streamType), data);
    return Buffer.concat([data, Buffer.from([checksum])]);
  }

  /** Verifies the checksum against the raw bytes this packet was parsed from. */
  validate(ctx: Context, raw: Buffer) {
    const expected = calcChecksum(checksumKey(ctx, this.destination.streamType), raw.subarray(0, raw.length - 1));
    if (this.checksum !== expected) {
      throw new PacketError("Invalid checksum");
    }
  }

  toString() {
    const specific =
      this.connSignature !== undefined
        ? ` conn_sig=${hex32(this.connSignature)}`
        : this.fragmentId !== undefined
          ? ` fragment=${this.fragmentId}`
          : "";
    return (
      `QPacket(${PacketType[this.packetType]} ${formatVPort(this.source)} -> ${formatVPort(this.destination)} ` +
      `flags=${formatFlags(this.flags)} session=${this.sessionId} sig=${hex32(this.signature)} seq=${this.sequence}` +
      `${specific} payload=${this.payload.length}B${this.useCompression ? " compressed" : ""})`
    );
  }
}

function hex32(value: number) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Sums the little-endian u32 words of `data`, folds that sum into a byte, and adds
 * the trailing bytes and the key (all wrapping).
 */
export function calcChecksum(key: number, data: Uint8Array) {
  const aligned = data.length - (data.length % 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let words = 0;
  for (let i = 0; i < aligned; i += 4) {
    words = (words + view.getUint32(i, true)) >>> 0;
  }
  let sum = (words & 0xff) + ((words >>> 8) & 0xff) + ((words >>> 16) & 0xff) + (words >>> 24) + (key & 0xff);
  for (let i = aligned; i < data.length; i++) {
    sum += data[i];
  }
  return sum & 0xff;
}
