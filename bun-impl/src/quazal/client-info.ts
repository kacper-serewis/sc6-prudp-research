import { randomInt } from "node:crypto";
import type { SocketAddress } from "./context";

export function randomU32() {
  return randomInt(0, 0x1_0000_0000);
}

/** State of a PRUDP connection (port of `quazal::ClientInfo`). */
export class ClientInfo {
  serverSequenceId = 1;
  clientSequenceId = 1;
  clientSignature?: number;
  readonly serverSignature = randomU32();
  clientSession = 0;
  serverSession = 0;
  /** Buffered DATA fragments by fragment id; fragment 0 terminates a message. */
  readonly packetFragments = new Map<number, Buffer>();
  lastSeen = Date.now();
  connectionId?: number;
  /** Principal id of the logged in user. */
  userId?: number;

  constructor(readonly address: SocketAddress) {}

  seen() {
    this.lastSeen = Date.now();
  }
}
