import { describe, expect, test } from "bun:test";
import {
  parseRmcPacket,
  parseRmcRequest,
  parseRmcResponse,
  serializeRmcRequest,
  serializeRmcResponse,
} from "./packet";

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

function fromHex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

describe("Response (Rust test_response, rmc.rs:461)", () => {
  test("ok response", () => {
    const wire = serializeRmcResponse({
      protocolId: 1,
      ok: { callId: 2, methodId: 3, data: Buffer.from("Hello") },
    });
    expect(hex(wire)).toBe(hex(Buffer.from("0f0000000101020000000380000048656c6c6f", "hex")));
  });

  test("error response", () => {
    const wire = serializeRmcResponse({
      protocolId: 1,
      error: { callId: 2, errorCode: 3 },
    });
    expect(hex(wire)).toBe(hex(Buffer.from("0a000000010003000000020000 00".replace(/ /g, ""), "hex")));
  });

  test("parse ok response masks methodId with ~0x8000", () => {
    const resp = parseRmcResponse(fromHex("0f0000000101020000000380000048656c6c6f"));
    expect(resp.protocolId).toBe(1);
    expect(resp.ok).toBeDefined();
    expect(resp.ok!.callId).toBe(2);
    expect(resp.ok!.methodId).toBe(3);
    expect(Buffer.from(resp.ok!.data).toString()).toBe("Hello");
  });

  test("response round-trips", () => {
    const original = "0f0000000101020000000380000048656c6c6f";
    expect(hex(serializeRmcResponse(parseRmcResponse(fromHex(original))))).toBe(original);
  });
});

describe("Request (Rust test_request, rmc.rs:486)", () => {
  const data = fromHex(
    "480000008a080000000200000003007776002100556269417574 68656e7469636174696f6e4c6f67696e437573746f6d4461746100130000000f000000030077760001000005007465737400".replace(
      / /g,
      ""
    )
  );

  test("parses protocol/call/method and reads params to end", () => {
    const req = parseRmcRequest(data);
    // 0x8a & ~0x80 = 0x0a = 10
    expect(req.protocolId).toBe(10);
    expect(req.callId).toBe(8);
    expect(req.methodId).toBe(2);
    expect(req.parameters.length).toBe(data.length - 4 - 1 - 4 - 4);
  });

  test("round-trips byte-exact", () => {
    const req = parseRmcRequest(data);
    expect(hex(serializeRmcRequest(req))).toBe(hex(data));
  });

  test("2-byte protocol id (sentinel 0xff)", () => {
    const req = { protocolId: 0x1234, callId: 1, methodId: 2, parameters: new Uint8Array(0) };
    const wire = serializeRmcRequest(req);
    expect(wire[4]).toBe(0xff);
    const back = parseRmcRequest(wire);
    expect(back.protocolId).toBe(0x1234);
  });
});

describe("parseRmcPacket discrimination", () => {
  test("request when data[4] & 0x80 set", () => {
    const req = serializeRmcRequest({
      protocolId: 10,
      callId: 1,
      methodId: 2,
      parameters: new Uint8Array(0),
    });
    expect(parseRmcPacket(req).kind).toBe("request");
  });

  test("response when data[4] & 0x80 clear", () => {
    const resp = serializeRmcResponse({
      protocolId: 1,
      ok: { callId: 2, methodId: 3, data: new Uint8Array(0) },
    });
    expect(parseRmcPacket(resp).kind).toBe("response");
  });
});
