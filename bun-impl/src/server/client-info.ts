export class ClientInfo {
  serverSequenceId: number;
  clientSequenceId: number;
  clientSignature?: number;
  serverSignature: number;
  clientSession: number;
  serverSession: number;
  packetFragments: Map<number, Uint8Array>;
  lastSeen: Date;
  connectionId?: number;
  userId?: number;

  constructor(serverSignature: number) {
    this.serverSequenceId = 1;
    this.clientSequenceId = 1;
    this.serverSignature = serverSignature;
    this.clientSession = 0;
    this.serverSession = 0;
    this.packetFragments = new Map();
    this.lastSeen = new Date();
  }
}
