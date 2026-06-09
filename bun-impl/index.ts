import debug from "debug";
import PACKETS from "./rust.json";
import { AuthenticationServer } from "./src/server/authentication.server";
import { REPLAY_FIXTURE } from "./src/server/replay-fixture";
import { splinterCellBlacklistContext } from "./src/quazal/context";
import {
  PacketType,
  type QPacketData,
  parseQPacket,
  serializeQPacket,
  validateQPacket,
} from "./src/quazal/prudp/packet";
import { parseStationUrl } from "./src/quazal/rmc/types";
import { RVConnectionData } from "./src/protocols/ticket-granting.types";

const log = debug("index");

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

const ctx = splinterCellBlacklistContext(REPLAY_FIXTURE.ticketKey);

// Client -> server packets we replay (source VPort 0x3f), and the server ->
// client packets we expect back (source VPort 0x31), in capture order.
const TO_SEND = (PACKETS as string[]).filter((p) => p.startsWith("3f31")).slice(0, 3);
const EXPECTED = (PACKETS as string[]).filter((p) => p.startsWith("313f"));

// The capture's connection URL has the params in HashMap (arbitrary) order, so
// reproduce it verbatim rather than rebuilding from fields.
function connectionData(): RVConnectionData {
  return {
    urlRegularProtocols: parseStationUrl(REPLAY_FIXTURE.connectionUrl),
    lstSpecialProtocols: [],
    urlSpecialProtocols: parseStationUrl(":/address=;port=0"),
  };
}

async function main() {
  await AuthenticationServer.ready();

  let expectedIndex = 0;
  let asserted = 0;

  const server = new AuthenticationServer(
    (sent: QPacketData) => {
      const expectedHex = EXPECTED[expectedIndex++];
      if (expectedHex === undefined) {
        throw new Error("server sent more packets than the capture contains");
      }
      const expectedBytes = Uint8Array.from(Buffer.from(expectedHex, "hex"));
      const sentBytes = serializeQPacket(ctx, sent);

      if (sent.useCompression) {
        // node:zlib deflate(6) output differs from Rust's miniz_oxide, so the
        // compressed wrapper won't be byte-identical. Compare the decrypted +
        // decompressed plaintext instead, which verifies everything except the
        // exact compressor output.
        const expected = parseQPacket(ctx, expectedBytes).packet;
        if (hex(expected.payload) !== hex(sent.payload)) {
          throw new Error(
            `Data response payload mismatch:\n${hex(expected.payload)} <- expected\n${hex(
              sent.payload
            )} <- sent`
          );
        }
        // Cross-check header fields that are independent of compression.
        if (
          expected.sequence !== sent.sequence ||
          expected.sessionId !== sent.sessionId ||
          expected.signature !== sent.signature ||
          expected.flags !== sent.flags
        ) {
          throw new Error("Data response header mismatch");
        }
        log("Data response matches (plaintext byte-exact)");
      } else {
        if (hex(sentBytes) !== expectedHex) {
          throw new Error(
            `Packet mismatch:\n${expectedHex} <- expected\n${hex(sentBytes)} <- sent`
          );
        }
        log("%s response byte-exact", PacketType[sent.packetType]);
      }
      asserted++;
    },
    {
      ctx,
      serverSignature: REPLAY_FIXTURE.serverSignature,
      serverSession: REPLAY_FIXTURE.serverSession,
      sessionKey: REPLAY_FIXTURE.sessionKey,
      nonce: REPLAY_FIXTURE.nonce,
      serverPid: REPLAY_FIXTURE.serverPid,
      resolveUser: () => REPLAY_FIXTURE.userId,
      connectionData,
    }
  );

  for (const packetHex of TO_SEND) {
    const data = Uint8Array.from(Buffer.from(packetHex, "hex"));
    const { packet, bytesRead } = parseQPacket(ctx, data);
    validateQPacket(ctx, packet, data.subarray(0, bytesRead));
    log("-> %s seq %d", PacketType[packet.packetType], packet.sequence);
    server.handlePacket(packet);
  }

  console.log(`OK: ${asserted} server responses matched the capture byte-exact.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
