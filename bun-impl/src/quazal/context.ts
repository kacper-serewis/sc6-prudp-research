/**
 * Per service settings shared by the PRUDP and RMC layers (port of `quazal::Context`).
 */
import { randomBytes } from "node:crypto";
import { StreamType } from "./prudp/stream-type";

export interface SocketAddress {
  host: string;
  port: number;
}

export interface Context {
  /** Game specific key, used for the packet checksums. */
  accessKey: Buffer;
  /** RC4 key for PRUDP payloads. */
  cryptoKey: Buffer;
  listen: SocketAddress;
  /** Virtual port the RMC handler is registered on. */
  vport: number;
  /** Set for authentication services, points clients to the secure service. */
  secureServerAddr?: SocketAddress;
  settings: Map<string, string>;
  /** 32 byte secretbox key used to seal Kerberos tickets. */
  ticketKey: Buffer;
}

export const TICKET_KEY_SIZE = 32;

export function defaultContext(overrides: Partial<Context> = {}): Context {
  return {
    accessKey: Buffer.alloc(0),
    cryptoKey: Buffer.from("CD&ML"),
    listen: { host: "0.0.0.0", port: 9999 },
    vport: 1,
    settings: new Map(),
    ticketKey: randomBytes(TICKET_KEY_SIZE),
    ...overrides,
  };
}

export function splinterCellBlacklistContext(overrides: Partial<Context> = {}): Context {
  return defaultContext({ accessKey: Buffer.from("yl4NG7qZ"), ...overrides });
}

/** Checksum key for packets sent to a stream of the given type. */
export function checksumKey(ctx: Context, streamType: StreamType) {
  if (streamType !== StreamType.RVSec) {
    return 0;
  }
  let sum = 0;
  for (const byte of ctx.accessKey) {
    sum = (sum + byte) >>> 0;
  }
  return sum;
}

/** Parses `host:port` or `[ipv6]:port`. */
export function parseSocketAddress(value: string): SocketAddress {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value.trim());
  const port = Number(match?.[3]);
  if (!match || port > 0xffff) {
    throw new Error(`invalid socket address "${value}"`);
  }
  return { host: match[1] ?? match[2], port };
}

export function formatSocketAddress({ host, port }: SocketAddress) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}
