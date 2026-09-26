/**
 * Decodes PRUDP packets and the RMC calls inside them (replaces quazal's `qpacket-decoder`,
 * `rmc-decoder` and `core-config-parser` tools).
 *
 * Usage:
 *   bun run scripts/decode.ts 3f3120000000000000000000000040 ...
 *   echo "3f:31:20:00:..." | bun run scripts/decode.ts        (one packet per line, hex)
 *
 * Fragmented RMC messages are reassembled per connection and direction.
 */
import * as protocols from "../src/protocols";
import { decode } from "../src/quazal/codec";
import { splinterCellBlacklistContext } from "../src/quazal/context";
import { formatFlags, formatVPort, PacketType, QPacket, StreamType } from "../src/quazal/prudp/packet";
import { parseRmcPacket } from "../src/quazal/rmc/message";
import type { ProtocolDefinition } from "../src/quazal/rmc/protocol";

const ctx = splinterCellBlacklistContext();
const byId = new Map<number, ProtocolDefinition>();
for (const protocol of Object.values(protocols) as ProtocolDefinition[]) {
  if (protocol.id !== undefined) {
    byId.set(protocol.id, protocol);
  }
}

const show = (value: unknown) => Bun.inspect(value, { depth: 10, colors: process.stdout.isTTY });

function describeRmc(data: Buffer) {
  const message = parseRmcPacket(data);
  if (message.type === "request") {
    const { protocolId, methodId, callId, parameters } = message.request;
    const protocol = byId.get(protocolId);
    const method = protocol && Object.values(protocol.methods).find((m) => m.id === methodId);
    console.log(`  RMC request #${callId} ${protocol?.name ?? protocolId}.${method?.name ?? methodId}`);
    console.log(method ? show(decode(method.request, parameters)) : `  parameters: ${parameters.toString("hex")}`);
    return;
  }
  const { protocolId, result } = message.response;
  const protocol = byId.get(protocolId);
  if (!result.ok) {
    console.log(`  RMC error #${result.callId} ${protocol?.name ?? protocolId}: 0x${result.errorCode.toString(16)}`);
    return;
  }
  const method = protocol && Object.values(protocol.methods).find((m) => m.id === result.methodId);
  console.log(`  RMC response #${result.callId} ${protocol?.name ?? protocolId}.${method?.name ?? result.methodId}`);
  console.log(method ? show(decode(method.response, result.data)) : `  data: ${result.data.toString("hex")}`);
}

const fragments = new Map<string, Buffer[]>();

function decodeDatagram(data: Buffer) {
  let offset = 0;
  while (offset < data.length) {
    const { packet, size } = QPacket.fromBytes(ctx, data.subarray(offset));
    const raw = data.subarray(offset, offset + size);
    offset += size;
    let valid = true;
    try {
      packet.validate(ctx, raw);
    } catch {
      valid = false;
    }
    console.log(
      `${PacketType[packet.packetType]} ${formatVPort(packet.source)} -> ${formatVPort(packet.destination)} ` +
        `flags=${formatFlags(packet.flags)} session=${packet.sessionId} sig=0x${packet.signature.toString(16)} seq=${packet.sequence}` +
        (packet.connSignature !== undefined ? ` conn_sig=0x${packet.connSignature.toString(16)}` : "") +
        (packet.fragmentId !== undefined ? ` fragment=${packet.fragmentId}` : "") +
        ` checksum=${valid ? "valid" : "INVALID"}${packet.useCompression ? " compressed" : ""}`,
    );
    if (packet.payload.length === 0) {
      continue;
    }
    if (packet.packetType !== PacketType.Data || packet.source.streamType !== StreamType.RVSec) {
      console.log(`  payload: ${packet.payload.toString("hex")}`);
      continue;
    }
    const key = `${packet.signature}:${packet.source.port}`;
    const parts = [...(fragments.get(key) ?? []), packet.payload];
    if (packet.fragmentId !== 0) {
      fragments.set(key, parts);
      console.log(`  fragment of ${packet.payload.length} bytes`);
      continue;
    }
    fragments.delete(key);
    try {
      describeRmc(Buffer.concat(parts));
    } catch (e) {
      console.log(`  payload (${(e as Error).message}): ${Buffer.concat(parts).toString("hex")}`);
    }
  }
}

const inputs = process.argv.length > 2 ? process.argv.slice(2) : (await Bun.stdin.text()).split("\n");
for (const line of inputs) {
  const hex = line.replace(/[^0-9a-fA-F]/g, "");
  if (!hex) {
    continue;
  }
  try {
    decodeDatagram(Buffer.from(hex, "hex"));
  } catch (e) {
    console.log(`invalid packet ${hex.slice(0, 32)}...: ${(e as Error).message}`);
  }
}
