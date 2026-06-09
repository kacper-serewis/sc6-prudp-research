// RMC (Remote Method Call) packet framing — port of quazal/src/rmc.rs.
import { ReadStream, WriteStream } from "./basic";

export interface RmcRequest {
  protocolId: number;
  callId: number;
  methodId: number;
  parameters: Uint8Array;
}

export interface RmcResponseData {
  callId: number;
  methodId: number;
  data: Uint8Array;
}

export interface RmcResponseError {
  errorCode: number;
  callId: number;
}

export interface RmcResponse {
  protocolId: number;
  /** Exactly one of these is set. */
  ok?: RmcResponseData;
  error?: RmcResponseError;
}

export type RmcPacket =
  | { kind: "request"; request: RmcRequest }
  | { kind: "response"; response: RmcResponse };

export function parseRmcRequest(data: Uint8Array): RmcRequest {
  const s = new ReadStream(data);
  const size = s.u32();
  if (size < data.length - 4) {
    throw new Error(`Not enough data. Expected ${size}, got ${data.length - 4}`);
  }
  let protocolId = s.u8();
  protocolId = protocolId === 0xff ? s.u16() : protocolId & ~0x80;
  const callId = s.u32();
  const methodId = s.u32();
  const parameters = s.readAll();
  return { protocolId, callId, methodId, parameters };
}

export function serializeRmcRequest(req: RmcRequest): Uint8Array {
  const body = new WriteStream();
  if (req.protocolId < 0xff) {
    body.u8(req.protocolId | 0x80);
  } else {
    body.u8(0xff).u16(req.protocolId);
  }
  body.u32(req.callId).u32(req.methodId).bytes(req.parameters);
  const bytes = body.toBytes();

  const out = new WriteStream();
  out.u32(bytes.length).bytes(bytes);
  return out.toBytes();
}

export function parseRmcResponse(data: Uint8Array): RmcResponse {
  const s = new ReadStream(data);
  s.u32(); // size
  let protocolId = s.u8();
  protocolId = protocolId === 0x7f ? s.u16() : protocolId;
  const status = s.u8();
  if (status === 1) {
    const callId = s.u32();
    const methodId = s.u32() & ~0x8000;
    const responseData = s.readAll();
    return { protocolId, ok: { callId, methodId, data: responseData } };
  }
  if (status === 0) {
    const errorCode = s.u32();
    const callId = s.u32();
    return { protocolId, error: { errorCode, callId } };
  }
  throw new Error(`Invalid RMC response status ${status}`);
}

export function serializeRmcResponse(resp: RmcResponse): Uint8Array {
  const body = new WriteStream();
  if (resp.protocolId < 0x7f) {
    body.u8(resp.protocolId);
  } else {
    body.u8(0x7f).u16(resp.protocolId);
  }
  if (resp.ok) {
    body.u8(1).u32(resp.ok.callId).u32((resp.ok.methodId | 0x8000) >>> 0).bytes(resp.ok.data);
  } else if (resp.error) {
    body.u8(0).u32(resp.error.errorCode).u32(resp.error.callId);
  } else {
    throw new Error("RMC response must have either ok or error");
  }
  const bytes = body.toBytes();

  const out = new WriteStream();
  out.u32(bytes.length).bytes(bytes);
  return out.toBytes();
}

/** Discriminates request vs response by the protocol-byte high bit (`data[4] & 0x80`). */
export function parseRmcPacket(data: Uint8Array): RmcPacket {
  if (data.length < 5) {
    throw new Error(`Not enough data. Expected 5, got ${data.length}`);
  }
  if ((data[4] & 0x80) === 0) {
    return { kind: "response", response: parseRmcResponse(data) };
  }
  return { kind: "request", request: parseRmcRequest(data) };
}
