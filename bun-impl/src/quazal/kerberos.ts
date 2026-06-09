// Kerberos ticket sealing — port of quazal/src/kerberos.rs.
import crypto from "node:crypto";
import _sodium from "libsodium-wrappers";
import {
  type Infer,
  WriteStream,
  fixedBytes,
  fromBytes,
  qbuffer,
  qstruct,
  toBytes,
  u32,
  u64,
} from "./rmc/basic";
import { Rc4, cryptKey } from "./prudp/crypto";

export const SESSION_KEY_SIZE = 16;
export const NONCE_BYTES = 24;

/** Internal ticket payload: principleId u32 + validUntil u64 + sessionKey[16] (raw). */
export const kerberosTicketInternal = qstruct({
  principleId: u32,
  validUntil: u64,
  sessionKey: fixedBytes(SESSION_KEY_SIZE),
});
export type KerberosTicketInternal = Infer<typeof kerberosTicketInternal>;

async function sodium() {
  await _sodium.ready;
  return _sodium;
}

/** Seals the internal ticket: 24-byte secretbox nonce + ciphertext. Nonce injectable for tests. */
export async function sealInternal(
  internal: KerberosTicketInternal,
  key: Uint8Array,
  nonce?: Uint8Array
): Promise<Uint8Array> {
  const s = await sodium();
  const n = nonce ?? s.randombytes_buf(NONCE_BYTES);
  const plaintext = toBytes(kerberosTicketInternal, internal);
  const sealed = s.crypto_secretbox_easy(plaintext, n, key);
  const out = new Uint8Array(n.length + sealed.length);
  out.set(n);
  out.set(sealed, n.length);
  return out;
}

/** Opens a sealed internal ticket. */
export async function openInternal(
  data: Uint8Array,
  key: Uint8Array
): Promise<KerberosTicketInternal> {
  const s = await sodium();
  if (data.length < NONCE_BYTES) {
    throw new Error(`got ${data.length} bytes, required at least ${NONCE_BYTES}`);
  }
  const nonce = data.subarray(0, NONCE_BYTES);
  const ciphertext = data.subarray(NONCE_BYTES);
  const plaintext = s.crypto_secretbox_open_easy(ciphertext, nonce, key);
  return fromBytes(kerberosTicketInternal, plaintext);
}

/** Derives the RC4/HMAC key: `65000 + pid%1024` MD5 iterations of the password. */
export function deriveKey(peerPid: number, password = "UbiDummyPwd"): Uint8Array {
  const count = 65000 + (peerPid % 1024);
  let key: Uint8Array = new TextEncoder().encode(password);
  for (let i = 0; i < count; i++) {
    key = crypto.createHash("md5").update(key).digest();
  }
  return key;
}

export interface KerberosTicket {
  sessionKey: Uint8Array; // 16 bytes
  pid: number;
  internal: KerberosTicketInternal;
}

/**
 * Serializes a ticket to wire bytes:
 *   inner = sessionKey(16) ++ u32le(pid) ++ qbuffer(sealedInternal)
 *   ciphertext = RC4(deriveKey(peerPid), inner)
 *   result = ciphertext ++ HMAC-MD5(deriveKey)(ciphertext)
 */
export async function ticketToBytes(
  ticket: KerberosTicket,
  peerPid: number,
  ticketKey: Uint8Array,
  options?: { password?: string; nonce?: Uint8Array }
): Promise<Uint8Array> {
  const sealed = await sealInternal(ticket.internal, ticketKey, options?.nonce);

  const inner = new WriteStream();
  inner.bytes(ticket.sessionKey).u32(ticket.pid);
  inner.write(qbuffer, sealed);
  const innerBytes = inner.toBytes();

  const derived = deriveKey(peerPid, options?.password);
  const ciphertext = cryptKey(derived, innerBytes);

  const mac = crypto.createHmac("md5", derived).update(ciphertext).digest();

  const out = new Uint8Array(ciphertext.length + mac.length);
  out.set(ciphertext);
  out.set(mac, ciphertext.length);
  return out;
}

/** Parses ticket bytes produced by `ticketToBytes`, verifying the HMAC. */
export async function ticketFromBytes(
  data: Uint8Array,
  peerPid: number,
  ticketKey: Uint8Array,
  options?: { password?: string }
): Promise<KerberosTicket> {
  const macSize = 16;
  const ciphertext = data.subarray(0, data.length - macSize);
  const mac = data.subarray(data.length - macSize);

  const derived = deriveKey(peerPid, options?.password);
  const expectedMac = crypto.createHmac("md5", derived).update(ciphertext).digest();
  if (!crypto.timingSafeEqual(Buffer.from(mac), expectedMac)) {
    throw new Error("Kerberos ticket HMAC mismatch");
  }

  const inner = cryptKey(derived, ciphertext);
  const sessionKey = inner.subarray(0, SESSION_KEY_SIZE);
  const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  const pid = view.getUint32(SESSION_KEY_SIZE, true);
  const sealed = fromBytes(qbuffer, inner.subarray(SESSION_KEY_SIZE + 4));
  const internal = await openInternal(sealed, ticketKey);

  return { sessionKey: sessionKey.slice(), pid, internal };
}

export { Rc4 };
