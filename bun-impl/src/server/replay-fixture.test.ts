import { describe, expect, test } from "bun:test";
import PACKETS from "../../rust.json";
import { fromBytes } from "../quazal/rmc/basic";
import { stationUrlToString } from "../quazal/rmc/types";
import { parseRmcPacket } from "../quazal/rmc/packet";
import { parseQPacket } from "../quazal/prudp/packet";
import { splinterCellBlacklistContext } from "../quazal/context";
import { LoginExResponse } from "../protocols/ticket-granting.types";
import { deriveKey, ticketFromBytes } from "../quazal/kerberos";
import { cryptKey } from "../quazal/prudp/crypto";
import { REPLAY_FIXTURE } from "./replay-fixture";

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

// Index 6 is the server's captured LoginEx Data response.
const CAPTURED_RESPONSE = Uint8Array.from(Buffer.from(PACKETS[6], "hex"));

describe("captured LoginEx response decodes to REPLAY_FIXTURE", () => {
  const ctx = splinterCellBlacklistContext(REPLAY_FIXTURE.ticketKey);

  test("PRUDP -> RMC -> LoginExResponse", () => {
    const { packet } = parseQPacket(ctx, CAPTURED_RESPONSE);
    expect(packet.useCompression).toBe(true);
    expect(packet.sessionId).toBe(REPLAY_FIXTURE.serverSession);

    const rmc = parseRmcPacket(packet.payload);
    expect(rmc.kind).toBe("response");
    if (rmc.kind !== "response" || !rmc.response.ok) throw new Error("expected ok response");
    expect(rmc.response.protocolId).toBe(10);
    expect(rmc.response.ok.methodId).toBe(2);

    const resp = fromBytes(LoginExResponse, rmc.response.ok.data);
    expect(resp.returnValue).toBe(0x10001);
    expect(resp.pidPrincipal).toBe(REPLAY_FIXTURE.userId);
    expect(resp.strReturnMsg).toBe("");
    expect(stationUrlToString(resp.pConnectionData.urlRegularProtocols)).toBe(
      REPLAY_FIXTURE.connectionUrl
    );
    expect(resp.pConnectionData.lstSpecialProtocols).toEqual([]);
  });

  test("ticket decrypts to fixture session key / nonce / pid / validUntil and HMAC verifies", async () => {
    const { packet } = parseQPacket(ctx, CAPTURED_RESPONSE);
    const rmc = parseRmcPacket(packet.payload);
    if (rmc.kind !== "response" || !rmc.response.ok) throw new Error("expected ok response");
    const resp = fromBytes(LoginExResponse, rmc.response.ok.data);

    // ticketFromBytes verifies the HMAC internally (throws on mismatch).
    const ticket = await ticketFromBytes(resp.pbufResponse, REPLAY_FIXTURE.userId, ctx.ticketKey);
    expect(ticket.pid).toBe(REPLAY_FIXTURE.serverPid);
    expect(hex(ticket.sessionKey)).toBe(hex(REPLAY_FIXTURE.sessionKey));
    expect(ticket.internal.principleId).toBe(REPLAY_FIXTURE.userId);
    expect(ticket.internal.validUntil).toBe(REPLAY_FIXTURE.validUntil);
    expect(hex(ticket.internal.sessionKey)).toBe(hex(REPLAY_FIXTURE.sessionKey));
  });

  test("the sealed nonce in the ticket matches the fixture nonce", () => {
    const { packet } = parseQPacket(ctx, CAPTURED_RESPONSE);
    const rmc = parseRmcPacket(packet.payload);
    if (rmc.kind !== "response" || !rmc.response.ok) throw new Error("expected ok response");
    const resp = fromBytes(LoginExResponse, rmc.response.ok.data);

    // Manually peel the RC4 layer to expose the secretbox nonce.
    const tb: Uint8Array = resp.pbufResponse;
    const inner = cryptKey(deriveKey(REPLAY_FIXTURE.userId), tb.subarray(0, tb.length - 16));
    const sealedLen = new DataView(inner.buffer, inner.byteOffset).getUint32(20, true);
    const nonce = inner.subarray(24, 24 + 24);
    expect(sealedLen).toBeGreaterThan(24);
    expect(hex(nonce)).toBe(hex(REPLAY_FIXTURE.nonce));
  });
});
