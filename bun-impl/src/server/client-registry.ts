import type { ClientInfo } from "./client-info";

export class ClientRegistry {
  clients: Map<number, ClientInfo> = new Map();
  connectionIdSessionIds: Map<number, number> = new Map(); // connId -> signature
}
