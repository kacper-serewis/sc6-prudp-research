import { describe, expect, test } from "bun:test";
import { loadRustSession } from "../../../test/fixtures/rust-session";
import { splinterCellBlacklistContext } from "../context";
import { calcChecksum, PacketFlag, PacketType, QPacket, StreamType } from "./packet";

const ctx = splinterCellBlacklistContext();

function roundTrip(hex: string) {
  const data = Buffer.from(hex, "hex");
  const { packet, size } = QPacket.fromBytes(ctx, data);
  expect(size).toBe(data.length);
  packet.validate(ctx, data);
  expect(packet.toBytes(ctx).toString("hex")).toBe(hex);
  return packet;
}

describe("QPacket", () => {
  // Test vectors from quazal/src/prudp/packet.rs
  test("SYN", () => {
    const packet = roundTrip("3f3120000000000000000000000040");
    expect(packet.packetType).toBe(PacketType.Syn);
    expect(packet.flags).toBe(PacketFlag.NeedAck);
    expect(packet.connSignature).toBe(0);
  });

  test("SYN ACK without size", () => {
    const packet = roundTrip("313f0800000000000000785634123c");
    expect(packet.flags).toBe(PacketFlag.Ack);
    expect(packet.connSignature).toBe(0x12345678);
  });

  test("CONNECT", () => {
    const packet = roundTrip("3e31319660300dd501003700bad21c");
    expect(packet.packetType).toBe(PacketType.Connect);
    expect(packet.source).toEqual({ port: 14, streamType: StreamType.RVSec });
  });

  test("DATA", () => {
    roundTrip("3f31327c60300dd50200000f9344db1375e25005a260fd2a16fbb1ab248796fc3fcc7b5a7f");
  });

  test("NAT user packet", () => {
    const data = Buffer.from("qq\x05\x00\x00\x00\x00\x00\x00\x00\x01\x053\x00\x00\x00\x00\xdcJ\x8d{\x80\x00\x01\x03\xd4", "latin1");
    const { packet, size } = QPacket.fromBytes(ctx, data);
    packet.validate(ctx, data.subarray(0, size));
    expect(packet.packetType).toBe(PacketType.User);
    expect(packet.source.streamType).toBe(StreamType.NATEcho);
  });

  test("decodes and decrypts a DATA packet (doc test)", () => {
    const data = Buffer.from([
      0x3f, 0x31, 0x32, 0xa7, 0x91, 0x93, 0x92, 0xdd, 0x4, 0x0, 0x0, 0xf, 0x89, 0x44, 0xdb, 0x13, 0x58, 0x3a, 0x50,
      0x5, 0xa2, 0x63, 0xfd, 0x2a, 0x16, 0xf1, 0xb1, 0x9b, 0x33, 0xe6, 0xe0,
    ]);
    const { packet } = QPacket.fromBytes(ctx, data);
    packet.validate(ctx, data);
    expect(packet).toMatchObject({
      source: { port: 15, streamType: StreamType.RVSec },
      destination: { port: 1, streamType: StreamType.RVSec },
      packetType: PacketType.Data,
      flags: PacketFlag.Reliable | PacketFlag.NeedAck,
      sessionId: 167,
      signature: 0xdd929391,
      fragmentId: 0,
      connSignature: undefined,
      sequence: 4,
      checksum: 0xe0,
      useCompression: false,
    });
    expect([...packet.payload]).toEqual([
      0xe, 0x0, 0x0, 0x0, 0xa7, 0x16, 0x0, 0x0, 0x0, 0x2, 0x0, 0x0, 0x0, 0x3, 0x0, 0x64, 0x65, 0x0,
    ]);
  });

  test("rejects invalid checksums, stream types and flags", () => {
    const valid = Buffer.from("3f3120000000000000000000000040", "hex");
    const badChecksum = Buffer.from(valid);
    badChecksum[badChecksum.length - 1] ^= 1;
    const { packet } = QPacket.fromBytes(ctx, badChecksum);
    expect(() => packet.validate(ctx, badChecksum)).toThrow("Invalid checksum");

    const badStream = Buffer.from(valid);
    badStream[0] = 0x9f;
    expect(() => QPacket.fromBytes(ctx, badStream)).toThrow("Invalid Stream Type");

    const badFlags = Buffer.from(valid);
    badFlags[2] = 0x80;
    expect(() => QPacket.fromBytes(ctx, badFlags)).toThrow("Invalid Flag");
  });

  test("compressed payloads survive a round trip", () => {
    const payload = Buffer.from("A".repeat(500) + "B".repeat(300));
    const packet = new QPacket({
      source: { port: 1, streamType: StreamType.RVSec },
      destination: { port: 15, streamType: StreamType.RVSec },
      packetType: PacketType.Data,
      flags: PacketFlag.HasSize | PacketFlag.Reliable,
      fragmentId: 0,
      payload,
      useCompression: true,
    });
    const bytes = packet.toBytes(ctx);
    expect(bytes.length).toBeLessThan(payload.length);
    const { packet: parsed } = QPacket.fromBytes(ctx, bytes);
    parsed.validate(ctx, bytes);
    expect(parsed.useCompression).toBe(true);
    expect(parsed.payload.equals(payload)).toBe(true);
  });

  test("checksum folds words and trailing bytes", () => {
    expect(calcChecksum(0, Buffer.from([1, 2, 3, 4, 5]))).toBe(15);
    expect(calcChecksum(0x2f3, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBe(0xee);
  });
});

describe("recorded game session", () => {
  const packets = loadRustSession();

  test("contains traffic in both directions", () => {
    expect(packets.length).toBeGreaterThan(200);
    expect(packets.some((p) => p.direction === "from-client")).toBe(true);
    expect(packets.some((p) => p.direction === "from-server")).toBe(true);
  });

  test("every packet parses, has a valid checksum and re-encodes to an equivalent packet", () => {
    // One compressed challenge list sent by the Rust server has a corrupt zlib stream (its content
    // inflates to "DefiniT_2." instead of "Definition" and fails the Adler-32 check). miniz_oxide
    // verifies Adler-32 as well, so rejecting it matches the Rust implementation.
    const corrupt = packets.flatMap(({ data }, index) => {
      try {
        QPacket.fromBytes(ctx, data);
        return [];
      } catch (e) {
        expect((e as Error).message).toStartWith("Decompression failed");
        return [index];
      }
    });
    expect(corrupt).toEqual([168]);

    for (const { data } of packets.filter((_, index) => !corrupt.includes(index))) {
      const { packet, size } = QPacket.fromBytes(ctx, data);
      expect(size).toBe(data.length);
      packet.validate(ctx, data);

      const encoded = packet.toBytes(ctx);
      if (!packet.useCompression) {
        // Deterministic encoding: must be byte for byte identical.
        expect(encoded.toString("hex")).toBe(data.toString("hex"));
      } else {
        // zlib output may differ from miniz_oxide, but the content must survive.
        const { packet: again } = QPacket.fromBytes(ctx, encoded);
        again.validate(ctx, encoded);
        expect(again.payload.equals(packet.payload)).toBe(true);
      }
    }
  });
});
