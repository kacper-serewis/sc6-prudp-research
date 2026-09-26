/**
 * Packets from `rust-session.txt`, a log of a real game session against the Rust server.
 * `PACKET:` lines were received from the game, `PACKET SEND:` lines were sent by the server.
 */
import { readFileSync } from "node:fs";
import { splinterCellBlacklistContext } from "../../src/quazal/context";
import { PacketFlag, PacketType, QPacket } from "../../src/quazal/prudp/packet";
import { parseRmcPacket, type RmcRequest } from "../../src/quazal/rmc/message";

export interface LoggedPacket {
  direction: "from-client" | "from-server";
  data: Buffer;
}

export interface RecordedRequest extends RmcRequest {
  /** Server signature of the connection the request was sent on. */
  connection: number;
}

/** RMC requests the game sent, reassembled from DATA fragments, in the order they were sent. */
export function loadRecordedRequests(): RecordedRequest[] {
  const ctx = splinterCellBlacklistContext();
  const fragments = new Map<number, Buffer[]>();
  const requests: RecordedRequest[] = [];
  for (const { direction, data } of loadRustSession()) {
    if (direction !== "from-client") {
      continue;
    }
    const { packet } = QPacket.fromBytes(ctx, data);
    if (packet.packetType !== PacketType.Data || packet.hasFlag(PacketFlag.Ack)) {
      continue;
    }
    const parts = fragments.get(packet.signature) ?? [];
    parts.push(packet.payload);
    fragments.set(packet.signature, parts);
    if (packet.fragmentId !== 0) {
      continue;
    }
    fragments.delete(packet.signature);
    const message = parseRmcPacket(Buffer.concat(parts));
    if (message.type === "request") {
      requests.push({ ...message.request, connection: packet.signature });
    }
  }
  return requests;
}

export function loadRustSession(): LoggedPacket[] {
  const log = readFileSync(new URL("./rust-session.txt", import.meta.url), "utf8");
  return [...log.matchAll(/PACKET( SEND)?: \[([^\]]+)\]/g)].map((match) => ({
    direction: match[1] ? "from-server" : "from-client",
    data: Buffer.from(match[2].split(", ").map((byte) => parseInt(byte, 16))),
  }));
}
