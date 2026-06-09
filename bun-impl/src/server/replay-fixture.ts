// Deterministic constants extracted from the captured LoginEx exchange
// (rust.json index 6). Injecting these into the auth server reproduces the
// captured Data response byte-for-byte (or, for the compressed wrapper,
// plaintext-exact). See replay-fixture.test.ts, which re-derives them from the
// capture end-to-end and asserts they match.

function fromHex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

/** The server's ticket secretbox key (Splinter Cell Blacklist). */
export const TICKET_KEY = Uint8Array.from([
  198, 226, 29, 218, 118, 124, 253, 219, 188, 169, 211, 0, 121, 181, 44, 221, 223, 85, 144, 82, 64,
  40, 122, 181, 11, 125, 106, 32, 56, 99, 96, 29,
]);

export const REPLAY_FIXTURE = {
  /** Server's own signature (== 0x747e2a38), echoed by the client during Connect. */
  serverSignature: 0x747e2a38,
  /** Server session id used for responses. */
  serverSession: 6,
  /** Authenticated user / principal id (sam_the_fisher). */
  userId: 1002,
  /** Server principal id baked into the ticket and connection URL. */
  serverPid: 0x1000,
  /** Ticket validity (Rust u64::MAX). */
  validUntil: 0xffffffffffffffffn,
  /** Session key handed to the client (16 bytes). */
  sessionKey: fromHex("06060606060606060606060606060606"),
  /** secretbox nonce used when sealing the internal ticket (24 bytes). */
  nonce: fromHex("2a608c0b319be8b284af7e66c736f30543e5db2bdc79b315"),
  /** Exact connection URL string (param order matches the capture's HashMap order). */
  connectionUrl: "prudps:/address=127.0.0.1;port=21171;CID=1;stream=3;type=2;PID=4096;sid=1",
  ticketKey: TICKET_KEY,
} as const;

export type ReplayFixture = typeof REPLAY_FIXTURE;
