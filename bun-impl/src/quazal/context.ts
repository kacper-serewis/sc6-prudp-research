// Service context — port of quazal/src/config.rs Context.
import { StreamType } from "./prudp/packet";

export interface Context {
  /** Access key for the service (checksum key source). */
  accessKey: Uint8Array;
  /** RC4 key for RVSec payloads. */
  cryptoKey: Uint8Array;
  /** secretbox key used to seal Kerberos tickets. */
  ticketKey: Uint8Array;
}

const utf8 = new TextEncoder();

export function splinterCellBlacklistContext(ticketKey?: Uint8Array): Context {
  return {
    accessKey: utf8.encode("yl4NG7qZ"),
    cryptoKey: utf8.encode("CD&ML"),
    ticketKey: ticketKey ?? new Uint8Array(32),
  };
}

/** Checksum key for a stream type: sum of the access-key bytes for RVSec, 0 otherwise. */
export function checksumKey(ctx: Context, streamType: StreamType): number {
  if (streamType !== StreamType.RVSec) return 0;
  let sum = 0;
  for (const b of ctx.accessKey) sum = (sum + b) >>> 0;
  return sum;
}
