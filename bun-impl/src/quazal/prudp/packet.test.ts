import { describe, expect, test } from "bun:test";
import PACKETS from "../../../rust.json";
import { splinterCellBlacklistContext } from "../context";
import {
  PacketFlag,
  PacketType,
  StreamType,
  calcChecksum,
  parseQPacket,
  serializeQPacket,
  validateQPacket,
  vportFromByte,
  vportToByte,
} from "./packet";

const ctx = splinterCellBlacklistContext();

function fromHex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

describe("VPort", () => {
  test("byte layout is port | (streamType << 4)", () => {
    expect(vportToByte({ port: 15, streamType: StreamType.RVSec })).toBe(0x3f);
    expect(vportFromByte(0x3f)).toEqual({ port: 15, streamType: StreamType.RVSec });
    expect(vportFromByte(0x31)).toEqual({ port: 1, streamType: StreamType.RVSec });
  });
});

describe("parse (Rust doc example, packet.rs)", () => {
  test("client Data packet without HasSize", () => {
    const data = fromHex(
      "3f3132a7919392dd040000" + "0f8944db13583a5005a263fd2a16f1b19b33e6e0"
    );
    const { packet } = parseQPacket(ctx, data);
    expect(packet.source).toEqual({ port: 15, streamType: StreamType.RVSec });
    expect(packet.destination).toEqual({ port: 1, streamType: StreamType.RVSec });
    expect(packet.packetType).toBe(PacketType.Data);
    expect(packet.flags).toBe(PacketFlag.Reliable | PacketFlag.NeedAck);
    expect(packet.sessionId).toBe(167);
    expect(packet.signature).toBe(0xdd929391);
    expect(packet.fragmentId).toBe(0);
    expect(packet.connSignature).toBeUndefined();
    expect(packet.sequence).toBe(4);
    expect(hex(packet.payload)).toBe("0e000000a716000000020000000300646500");
    expect(packet.checksum).toBe(0xe0);
    expect(packet.useCompression).toBe(false);
  });
});

describe("round-trip (Rust test_syn vectors, packet.rs)", () => {
  const vectors = [
    "3f3120000000000000000000000040",
    "313f0800000000000000785634123c",
    "3e313196 60300dd5 0100 3700 bad21c".replace(/ /g, ""),
    "3f31327c60300dd50200000f9344db1375e25005a260fd2a16fbb1ab24879" + "6fc3fcc7b5a7f",
  ];

  test.each(vectors.map((v) => [v] as const))("%s", (vecHex) => {
    const data = fromHex(vecHex);
    const { packet, bytesRead } = parseQPacket(ctx, data);
    expect(bytesRead).toBe(data.length);
    expect(hex(serializeQPacket(ctx, packet))).toBe(vecHex);
    expect(calcChecksum(ctx, packet)).toBe(packet.checksum);
    expect(() => validateQPacket(ctx, packet, data)).not.toThrow();
  });
});

describe("parse (Rust nat_packet vector)", () => {
  // A non-RVSec packet with a payload does not strip a compression-flag byte on
  // parse, but Rust's serializer always prepends one, so a byte-exact round-trip
  // is not expected here (and Rust doesn't assert it either). Just validate parse.
  test("NATEcho packet validates", () => {
    const data = Uint8Array.from(
      Buffer.from("7171050000000000000001053300000000dc4a8d7b80000103d4", "hex")
    );
    const { packet, bytesRead } = parseQPacket(ctx, data);
    expect(bytesRead).toBe(data.length);
    expect(packet.source.streamType).toBe(StreamType.NATEcho);
    expect(packet.packetType).toBe(PacketType.User);
    expect(() => validateQPacket(ctx, packet, data.subarray(0, bytesRead))).not.toThrow();
  });
});

describe("compression", () => {
  test("server Data packet payload is RC4'd and zlib-compressed", () => {
    // Captured LoginEx response (rust.json index 6)
    const data = fromHex(PACKETS[6]);
    const { packet } = parseQPacket(ctx, data);
    expect(packet.useCompression).toBe(true);
    expect(packet.payload.length).toBe(236);
    // RMC response header: u32 size prefix + protocol 10 + status ok
    expect(hex(packet.payload.subarray(0, 6))).toBe("e80000000a01");
  });

  test("compressed payloads re-parse to identical plaintext", () => {
    const data = fromHex(PACKETS[6]);
    const { packet } = parseQPacket(ctx, data);
    const reparsed = parseQPacket(ctx, serializeQPacket(ctx, packet)).packet;
    expect(hex(reparsed.payload)).toBe(hex(packet.payload));
    expect(reparsed.sequence).toBe(packet.sequence);
    expect(reparsed.flags).toBe(packet.flags);
  });
});

describe("whole-capture regression (rust.json)", () => {
  // Index 168 is corrupt in the capture itself: its PRUDP checksum doesn't
  // validate (stored 0x92, calculated 0x79) and its zlib adler32 is bad.
  const KNOWN_CORRUPT = new Set([168]);

  test("every valid packet parses, validates, and re-serializes", () => {
    let exact = 0;
    let compressed = 0;

    PACKETS.forEach((pktHex, i) => {
      const data = fromHex(pktHex);

      if (KNOWN_CORRUPT.has(i)) {
        expect(() => parseQPacket(ctx, data)).toThrow();
        return;
      }

      let offset = 0;
      const out: string[] = [];
      while (offset < data.length) {
        const { packet, bytesRead } = parseQPacket(ctx, data, offset);
        validateQPacket(ctx, packet, data.subarray(offset, offset + bytesRead));

        const serialized = serializeQPacket(ctx, packet);
        if (packet.useCompression) {
          // node:zlib deflate(6) output differs from Rust's miniz_oxide, so
          // compressed packets are compared at the plaintext level instead.
          compressed++;
          const reparsed = parseQPacket(ctx, serialized).packet;
          expect(hex(reparsed.payload)).toBe(hex(packet.payload));
          out.push(pktHex.slice(offset * 2, (offset + bytesRead) * 2));
        } else {
          out.push(hex(serialized));
        }
        offset += bytesRead;
      }

      expect(out.join("")).toBe(pktHex);
      exact++;
    });

    expect(exact).toBe(PACKETS.length - KNOWN_CORRUPT.size);
    expect(compressed).toBeGreaterThan(0);
  });
});
