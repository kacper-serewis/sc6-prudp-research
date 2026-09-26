import { afterEach, describe, expect, test } from "bun:test";
import { silentLogger } from "../../logger";
import { splinterCellBlacklistContext } from "../context";
import { PacketFlag, PacketType, QPacket, StreamType } from "./packet";
import { MAX_REASSEMBLED_SIZE, PrudpServer, type StreamHandler } from "./server";

const ctx = splinterCellBlacklistContext();
const from = { host: "127.0.0.1", port: 3074 };
const CLIENT = { port: 15, streamType: StreamType.RVSec };
const SERVER = { port: 1, streamType: StreamType.RVSec };

const servers: PrudpServer[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A server with an in-memory transport and a connected client. */
function connectedServer(handler: StreamHandler) {
  const server = new PrudpServer(silentLogger, ctx);
  servers.push(server);
  const sent: QPacket[] = [];
  server.attach({ send: (data) => void sent.push(QPacket.fromBytes(ctx, data).packet), close() {} });
  server.register(SERVER, handler);

  const packet = (init: Partial<QPacket>) => new QPacket({ source: CLIENT, destination: SERVER, ...init }).toBytes(ctx);
  server.handleDatagram(packet({ packetType: PacketType.Syn, flags: PacketFlag.NeedAck, connSignature: 0 }), from);
  const signature = sent.shift()!.connSignature!;
  server.handleDatagram(
    packet({ packetType: PacketType.Connect, flags: PacketFlag.NeedAck, signature, connSignature: 0x1234, sequence: 1 }),
    from,
  );
  sent.shift();

  let sequence = 2;
  const data = (payload: Buffer, fragmentId = 0, useCompression = false) =>
    packet({
      packetType: PacketType.Data,
      flags: PacketFlag.Reliable | PacketFlag.NeedAck | PacketFlag.HasSize,
      signature,
      sequence: sequence++,
      fragmentId,
      payload,
      useCompression,
    });
  return { server, sent, data, client: () => server.clients.get(signature)! };
}

describe("PrudpServer", () => {
  test("answers DATA packets with an ACK and the handler's response", () => {
    const { server, sent, data } = connectedServer({ handle: (_call, payload) => Buffer.concat([payload, payload]) });
    server.handleDatagram(data(Buffer.from("ab")), from);
    expect(sent.map((p) => [p.hasFlag(PacketFlag.Ack), p.payload.toString()])).toEqual([
      [true, ""],
      [false, "abab"],
    ]);
  });

  test("sends responses of asynchronous handlers once they resolve", async () => {
    const { server, sent, data } = connectedServer({ handle: async () => Buffer.from("later") });
    server.handleDatagram(data(Buffer.from("x")), from);
    expect(sent).toHaveLength(1); // only the ACK so far
    await Bun.sleep(0);
    expect(sent[1].payload.toString()).toBe("later");
    expect(sent[1].hasFlag(PacketFlag.Reliable)).toBe(true);
  });

  test("reassembles fragments but caps how much is buffered", () => {
    const received: Buffer[] = [];
    const { server, data, client } = connectedServer({ handle: (_call, payload) => (received.push(payload), Buffer.from("ok")) });

    server.handleDatagram(data(Buffer.from("a"), 1), from);
    server.handleDatagram(data(Buffer.from("b"), 2), from);
    server.handleDatagram(data(Buffer.from("c"), 0), from);
    expect(received.map(String)).toEqual(["abc"]);

    // Compressed fragments inflate to 60 KB each; buffering stops at MAX_REASSEMBLED_SIZE.
    const big = Buffer.alloc(60_000);
    for (let fid = 1; fid <= 20; fid++) {
      server.handleDatagram(data(big, fid, true), from);
      const buffered = [...client().packetFragments.values()].reduce((sum, f) => sum + f.length, 0);
      expect(buffered).toBeLessThanOrEqual(MAX_REASSEMBLED_SIZE);
    }
    server.handleDatagram(data(Buffer.from("end"), 0), from);
    expect(received).toHaveLength(1);
    expect(client().packetFragments.size).toBe(0);
  });

  test("drops decompression bombs without answering", () => {
    let calls = 0;
    const { server, sent, data } = connectedServer({ handle: () => (calls++, Buffer.from("ok")) });
    server.handleDatagram(data(Buffer.alloc(1024 * 1024), 0, true), from);
    expect(sent).toEqual([]);
    expect(calls).toBe(0);
  });
});
