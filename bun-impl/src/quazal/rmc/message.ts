/**
 * RMC (remote method call) messages carried in PRUDP DATA packets (port of `quazal::rmc`).
 *
 * Request:  size:u32, protocol:u8 (| 0x80, or 0xff + u16), call_id:u32, method_id:u32, parameters
 * Response: size:u32, protocol:u8 (or 0x7f + u16), status:u8, then
 *           status 1: call_id:u32, method_id | 0x8000:u32, data
 *           status 0: error_code:u32, call_id:u32
 */
import { ReadStream, StreamError } from "../stream";
import { RmcError, RmcErrorKind } from "./error";

export interface RmcRequest {
  protocolId: number;
  callId: number;
  methodId: number;
  parameters: Buffer;
}

export type RmcResult =
  | { ok: true; callId: number; methodId: number; data: Buffer }
  | { ok: false; errorCode: number; callId: number };

export interface RmcResponse {
  protocolId: number;
  result: RmcResult;
}

export type RmcPacket = { type: "request"; request: RmcRequest } | { type: "response"; response: RmcResponse };

function withSize(body: Buffer) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
}

export function parseRmcPacket(data: Buffer): RmcPacket {
  if (data.length < 5) {
    throw new RmcError(RmcErrorKind.MissingData, `Not enough data. Expected 5 bytes, got ${data.length}`);
  }
  try {
    if (data[4] & 0x80) {
      return { type: "request", request: parseRmcRequest(data) };
    }
    return { type: "response", response: parseRmcResponse(data) };
  } catch (e) {
    if (e instanceof StreamError) {
      throw new RmcError(RmcErrorKind.ParsingError, e.message);
    }
    throw e;
  }
}

export function parseRmcRequest(data: Buffer): RmcRequest {
  const s = new ReadStream(data);
  const size = s.u32();
  if (size < data.length - 4) {
    throw new RmcError(RmcErrorKind.MissingData, `Not enough data. Expected ${size} bytes, got ${data.length - 4}`);
  }
  let protocolId = s.u8();
  protocolId = protocolId === 0xff ? s.u16() : protocolId & ~0x80;
  const callId = s.u32();
  const methodId = s.u32();
  return { protocolId, callId, methodId, parameters: s.rest() };
}

export function encodeRmcRequest(request: RmcRequest) {
  const protocol =
    request.protocolId < 0xff
      ? Buffer.from([request.protocolId | 0x80])
      : Buffer.from([0xff, request.protocolId & 0xff, request.protocolId >> 8]);
  const ids = Buffer.alloc(8);
  ids.writeUInt32LE(request.callId >>> 0, 0);
  ids.writeUInt32LE(request.methodId >>> 0, 4);
  return withSize(Buffer.concat([protocol, ids, request.parameters]));
}

export function parseRmcResponse(data: Buffer): RmcResponse {
  const s = new ReadStream(data);
  s.u32(); // size
  let protocolId = s.u8();
  if (protocolId === 0x7f) {
    protocolId = s.u16();
  }
  const status = s.u8();
  if (status === 1) {
    const callId = s.u32();
    const methodId = s.u32() & ~0x8000;
    return { protocolId, result: { ok: true, callId, methodId, data: s.rest() } };
  }
  if (status === 0) {
    const errorCode = s.u32();
    const callId = s.u32();
    return { protocolId, result: { ok: false, errorCode, callId } };
  }
  throw new RmcError(RmcErrorKind.InvalidPacketType, `invalid response status ${status}`);
}

export function encodeRmcResponse(response: RmcResponse) {
  const protocol =
    response.protocolId < 0x7f
      ? Buffer.from([response.protocolId])
      : Buffer.from([0x7f, response.protocolId & 0xff, response.protocolId >> 8]);
  const { result } = response;
  const body = Buffer.alloc(9);
  if (result.ok) {
    body.writeUInt8(1, 0);
    body.writeUInt32LE(result.callId >>> 0, 1);
    body.writeUInt32LE((result.methodId | 0x8000) >>> 0, 5);
    return withSize(Buffer.concat([protocol, body, result.data]));
  }
  body.writeUInt8(0, 0);
  body.writeUInt32LE(result.errorCode >>> 0, 1);
  body.writeUInt32LE(result.callId >>> 0, 5);
  return withSize(Buffer.concat([protocol, body]));
}
