import { describe, expect, test } from "bun:test";
import { RmcError, RmcErrorKind } from "./error";
import { encodeRmcRequest, encodeRmcResponse, parseRmcPacket, parseRmcRequest, parseRmcResponse } from "./message";

describe("RMC messages", () => {
  // Test vectors from quazal/src/rmc.rs
  test("encodes responses", () => {
    expect(
      encodeRmcResponse({
        protocolId: 1,
        result: { ok: true, callId: 2, methodId: 3, data: Buffer.from("Hello") },
      }),
    ).toEqual(Buffer.from("\x0f\x00\x00\x00\x01\x01\x02\x00\x00\x00\x03\x80\x00\x00Hello", "latin1"));

    expect(encodeRmcResponse({ protocolId: 1, result: { ok: false, callId: 2, errorCode: 3 } })).toEqual(
      Buffer.from("\x0a\x00\x00\x00\x01\x00\x03\x00\x00\x00\x02\x00\x00\x00", "latin1"),
    );
  });

  test("parses a LoginEx request", () => {
    const data = Buffer.from([
      0x48, 0x00, 0x00, 0x00, 0x8a, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x77, 0x76, 0x00, 0x21,
      0x00, 0x55, 0x62, 0x69, 0x41, 0x75, 0x74, 0x68, 0x65, 0x6e, 0x74, 0x69, 0x63, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x4c,
      0x6f, 0x67, 0x69, 0x6e, 0x43, 0x75, 0x73, 0x74, 0x6f, 0x6d, 0x44, 0x61, 0x74, 0x61, 0x00, 0x13, 0x00, 0x00, 0x00,
      0x0f, 0x00, 0x00, 0x00, 0x03, 0x00, 0x77, 0x76, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x74, 0x65, 0x73, 0x74, 0x00,
    ]);
    const request = parseRmcRequest(data);
    expect(request).toMatchObject({ protocolId: 10, callId: 8, methodId: 2 });
    expect(request.parameters.length).toBe(data.length - 13);
    expect(encodeRmcRequest(request)).toEqual(data);
    expect(parseRmcPacket(data)).toEqual({ type: "request", request });
  });

  test("uses extended protocol ids above 0x7f", () => {
    const response = { protocolId: 5003, result: { ok: true as const, callId: 7, methodId: 1, data: Buffer.from([9]) } };
    const encoded = encodeRmcResponse(response);
    expect(encoded.subarray(4, 7)).toEqual(Buffer.from([0x7f, 0x8b, 0x13]));
    expect(parseRmcResponse(encoded)).toEqual(response);

    const request = { protocolId: 1001, callId: 1, methodId: 2, parameters: Buffer.alloc(0) };
    const encodedRequest = encodeRmcRequest(request);
    expect(encodedRequest.subarray(4, 7)).toEqual(Buffer.from([0xff, 0xe9, 0x03]));
    expect(parseRmcRequest(encodedRequest)).toEqual(request);
  });

  test("rejects short and oversized messages", () => {
    expect(() => parseRmcPacket(Buffer.from([1, 0, 0]))).toThrow(RmcError);
    const request = encodeRmcRequest({ protocolId: 10, callId: 1, methodId: 1, parameters: Buffer.from([1]) });
    expect(() => parseRmcRequest(Buffer.concat([request, Buffer.from([0])]))).toThrow("MissingData");
  });

  test("maps errors to Quazal error codes", () => {
    expect(new RmcError(RmcErrorKind.UnknownMethod).errorCode).toBe(0x80010001);
    expect(new RmcError(RmcErrorKind.UnimplementedMethod).errorCode).toBe(0x80010002);
    expect(new RmcError(RmcErrorKind.AccessDenied).errorCode).toBe(0x80010006);
    expect(new RmcError(RmcErrorKind.ParsingError).errorCode).toBe(0x8001000a);
    expect(new RmcError(RmcErrorKind.InternalError).errorCode).toBe(0x80010012);
    expect(RmcError.fromErrorCode(0x80010006)?.kind).toBe(RmcErrorKind.AccessDenied);
    expect(RmcError.fromErrorCode(0x10001)).toBeUndefined();
  });
});
