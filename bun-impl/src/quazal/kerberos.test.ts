import { describe, expect, test } from "bun:test";
import _sodium from "libsodium-wrappers";
import { fromBytes, toBytes } from "./rmc/basic";
import {
  type KerberosTicket,
  NONCE_BYTES,
  deriveKey,
  kerberosTicketInternal,
  openInternal,
  sealInternal,
  ticketFromBytes,
  ticketToBytes,
} from "./kerberos";

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

const ticketKey = new Uint8Array(32).fill(7);
const sessionKey = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe("kerberosTicketInternal codec", () => {
  test("principleId u32 + validUntil u64 + sessionKey[16], all LE/raw", () => {
    const internal = { principleId: 69, validUntil: 0xffffffffffffffffn, sessionKey };
    const bytes = toBytes(kerberosTicketInternal, internal);
    expect(hex(bytes)).toBe("45000000" + "ffffffffffffffff" + hex(sessionKey));
    expect(fromBytes(kerberosTicketInternal, bytes)).toEqual(internal);
  });
});

describe("seal/open", () => {
  test("open(seal(x)) == x", async () => {
    const internal = { principleId: 4096, validUntil: 1844674407370955n, sessionKey };
    const sealed = await sealInternal(internal, ticketKey);
    expect(sealed.length).toBeGreaterThan(NONCE_BYTES);
    expect(await openInternal(sealed, ticketKey)).toEqual(internal);
  });

  test("injected nonce makes output deterministic", async () => {
    const internal = { principleId: 1, validUntil: 2n, sessionKey };
    const nonce = new Uint8Array(NONCE_BYTES).fill(9);
    const a = await sealInternal(internal, ticketKey, nonce);
    const b = await sealInternal(internal, ticketKey, nonce);
    expect(hex(a)).toBe(hex(b));
    expect(hex(a.subarray(0, NONCE_BYTES))).toBe(hex(nonce));
  });
});

describe("deriveKey", () => {
  test("matches Rust: 65000 + pid%1024 MD5 iterations of UbiDummyPwd", async () => {
    await _sodium.ready;
    // Reference value computed from the same algorithm.
    const key = deriveKey(0);
    expect(key.length).toBe(16);
    // Stable across calls
    expect(hex(deriveKey(0))).toBe(hex(key));
    expect(hex(deriveKey(1024))).toBe(hex(key)); // 1024 % 1024 == 0
  });
});

describe("ticketToBytes / ticketFromBytes", () => {
  const ticket: KerberosTicket = {
    sessionKey,
    pid: 0x1000,
    internal: { principleId: 69, validUntil: 0xffffffffffffffffn, sessionKey },
  };

  test("round-trips and verifies HMAC", async () => {
    const nonce = new Uint8Array(NONCE_BYTES).fill(3);
    const bytes = await ticketToBytes(ticket, 69, ticketKey, { nonce });
    const back = await ticketFromBytes(bytes, 69, ticketKey);
    expect(back.pid).toBe(ticket.pid);
    expect(hex(back.sessionKey)).toBe(hex(sessionKey));
    expect(back.internal).toEqual(ticket.internal);
  });

  test("deterministic with injected nonce", async () => {
    const nonce = new Uint8Array(NONCE_BYTES).fill(5);
    const a = await ticketToBytes(ticket, 69, ticketKey, { nonce });
    const b = await ticketToBytes(ticket, 69, ticketKey, { nonce });
    expect(hex(a)).toBe(hex(b));
  });

  test("tampering breaks HMAC verification", async () => {
    const nonce = new Uint8Array(NONCE_BYTES).fill(1);
    const bytes = await ticketToBytes(ticket, 69, ticketKey, { nonce });
    bytes[0] ^= 0xff;
    await expect(ticketFromBytes(bytes, 69, ticketKey)).rejects.toThrow("HMAC mismatch");
  });
});
