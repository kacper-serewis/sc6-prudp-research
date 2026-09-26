import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  decodeKerberosTicket,
  deriveKey,
  encodeKerberosTicket,
  openTicketInternal,
  sealTicketInternal,
} from "./kerberos";

const ticketKey = randomBytes(32);
const sessionKey = Buffer.alloc(16, 6);
const internal = { principleId: 1002, validUntil: 0xffff_ffff_ffff_ffffn, sessionKey };

describe("kerberos", () => {
  test("derives keys with iterated MD5", () => {
    // 65000 + 1002 % 1024 rounds of MD5 over the default password.
    expect(deriveKey(1002).toString("hex")).toBe("77fbf02ddaa6efa46030350010929e20");
    expect(deriveKey(1002, "JaDe!").equals(deriveKey(1002))).toBe(false);
  });

  test("caches derived keys", () => {
    const first = deriveKey(5000);
    const start = performance.now();
    const second = deriveKey(5000 + 1024); // same iteration count
    expect(performance.now() - start).toBeLessThan(5);
    expect(second).toEqual(first);
    second[0] ^= 0xff; // callers get copies
    expect(deriveKey(5000)).toEqual(first);
  });

  test("seals and opens internal tickets", () => {
    const sealed = sealTicketInternal(internal, ticketKey);
    expect(sealed.length).toBe(24 + 16 + 28);
    expect(openTicketInternal(sealed, ticketKey)).toEqual(internal);
    expect(() => openTicketInternal(sealed, randomBytes(32))).toThrow("open failed");
    expect(() => openTicketInternal(sealed.subarray(0, 10), ticketKey)).toThrow();
  });

  test("tickets can be decrypted by the client and opened by the secure server", () => {
    const encoded = encodeKerberosTicket({ sessionKey, pid: 0x1000, internal }, 1002, null, ticketKey);
    // session key + pid + u32 length + sealed internal ticket + HMAC
    expect(encoded.length).toBe(16 + 4 + 4 + 68 + 16);

    const decoded = decodeKerberosTicket(encoded, 1002);
    expect(decoded.sessionKey).toEqual(sessionKey);
    expect(decoded.pid).toBe(0x1000);
    expect(openTicketInternal(decoded.sealedInternal, ticketKey)).toEqual(internal);

    expect(() => decodeKerberosTicket(encoded, 1002, "wrong password")).toThrow("MAC mismatch");
  });
});
