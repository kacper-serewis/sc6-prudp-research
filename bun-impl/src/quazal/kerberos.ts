/**
 * Kerberos-like tickets handed out by the authentication service (port of `quazal::kerberos`).
 *
 * The client receives a `KerberosTicket` encrypted with a key derived from its password. It
 * contains the session key and the sealed `KerberosTicketInternal`, which the client passes
 * on to the secure service when connecting. Only the servers can open the internal part.
 */
import { createHmac, hash, timingSafeEqual } from "node:crypto";
import nacl from "tweetnacl";
import { buffer, decode, encode, fixedBytes, struct, u32, u64, type Infer } from "./codec";
import { cryptKey } from "./rc4";
import { ReadStream, StreamError } from "./stream";

export const SESSION_KEY_SIZE = 16;
const DEFAULT_PASSWORD = "UbiDummyPwd";
const MAC_SIZE = 16;

export const KerberosTicketInternal = struct({
  principleId: u32,
  validUntil: u64,
  sessionKey: fixedBytes(SESSION_KEY_SIZE),
});
export type KerberosTicketInternal = Infer<typeof KerberosTicketInternal>;

/** Encrypts the internal ticket as `nonce || secretbox(ticket)`. */
export function sealTicketInternal(ticket: KerberosTicketInternal, key: Uint8Array) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const sealed = nacl.secretbox(encode(KerberosTicketInternal, ticket), nonce, key);
  return Buffer.concat([nonce, sealed]);
}

export function openTicketInternal(data: Uint8Array, key: Uint8Array): KerberosTicketInternal {
  const nonceSize = nacl.secretbox.nonceLength;
  if (data.length < nonceSize) {
    throw new StreamError(`got ${data.length} bytes, required at least ${nonceSize}`);
  }
  const opened = nacl.secretbox.open(data.subarray(nonceSize), data.subarray(0, nonceSize), key);
  if (!opened) {
    throw new StreamError("open failed");
  }
  return decode(KerberosTicketInternal, Buffer.from(opened));
}

export interface KerberosTicket {
  sessionKey: Buffer;
  /** Principal id of the service the ticket is for. */
  pid: number;
  internal: KerberosTicketInternal;
}

/** MD5 applied `65000 + peerPid % 1024` times to the password. */
export function deriveKey(peerPid: number, password?: string | null) {
  const count = 65000 + (peerPid % 1024);
  let key: Buffer = Buffer.from(password ?? DEFAULT_PASSWORD);
  for (let i = 0; i < count; i++) {
    key = hash("md5", key, "buffer") as Buffer;
  }
  return key;
}

/** Serializes and encrypts a ticket for the client `peerPid`. */
export function encodeKerberosTicket(
  ticket: KerberosTicket,
  peerPid: number,
  password: string | null | undefined,
  ticketKey: Uint8Array,
) {
  const plain = Buffer.concat([
    ticket.sessionKey,
    encode(u32, ticket.pid),
    encode(buffer, sealTicketInternal(ticket.internal, ticketKey)),
  ]);
  const key = deriveKey(peerPid, password);
  const encrypted = cryptKey(key, plain);
  const mac = createHmac("md5", key).update(encrypted).digest();
  return Buffer.concat([encrypted, mac]);
}

/**
 * Client side counterpart of `encodeKerberosTicket`. The sealed internal ticket is returned
 * as-is, since only the servers know the ticket key.
 */
export function decodeKerberosTicket(data: Buffer, peerPid: number, password?: string | null) {
  if (data.length < MAC_SIZE) {
    throw new StreamError("ticket too short");
  }
  const encrypted = data.subarray(0, data.length - MAC_SIZE);
  const key = deriveKey(peerPid, password);
  const mac = createHmac("md5", key).update(encrypted).digest();
  if (!timingSafeEqual(mac, data.subarray(data.length - MAC_SIZE))) {
    throw new StreamError("ticket MAC mismatch");
  }
  const s = new ReadStream(cryptKey(key, encrypted));
  return {
    sessionKey: s.bytes(SESSION_KEY_SIZE),
    pid: s.u32(),
    sealedInternal: buffer.read(s),
  };
}
