/**
 * Starts the Quazal services (port of `start_server` in `dedicated_server/src/main.rs`).
 */
import type { Logger } from "./logger";
import type { ClientInfo } from "./quazal/client-info";
import type { Context, SocketAddress } from "./quazal/context";
import { StreamType, type QPacket } from "./quazal/prudp/packet";
import { PrudpServer } from "./quazal/prudp/server";
import { RmcDispatcher } from "./quazal/rmc/protocol";
import { authenticationProtocols, secureProtocols, type ServiceDeps } from "./services";

/**
 * NAT detection: USER packets sent to the secure service are echoed back raw, with the
 * address the server saw appended.
 */
function handleUserPacket(logger: Logger, packet: QPacket, from: SocketAddress, server: PrudpServer) {
  if (packet.source.port !== 1 || packet.destination.port !== 1) {
    logger.warn(`unexpected user packet ${packet}`);
    return;
  }
  // Echoing a decompressed payload would turn the server into a traffic amplifier for spoofed
  // requests. The game's NAT probes are small and uncompressed.
  if (packet.useCompression) {
    logger.warn(`ignoring compressed user packet ${packet}`);
    return;
  }
  const address = Buffer.from(`udp:/address=${from.host};port=${from.port}\0`);
  server.sendRaw(Buffer.concat([packet.payload, address]), from);
}

export async function startQuazalServer(logger: Logger, ctx: Context, deps: ServiceDeps, secure: boolean) {
  const dispatcher = new RmcDispatcher(logger);
  for (const protocol of secure ? secureProtocols(deps) : authenticationProtocols(deps)) {
    dispatcher.register(protocol);
  }

  const server = new PrudpServer(logger, ctx);
  server.register({ streamType: StreamType.RVSec, port: ctx.vport }, dispatcher);

  const cleanup = (kind: string) => (client: ClientInfo) => {
    if (client.userId === undefined) {
      return;
    }
    logger.info(`Cleaning ${kind} session of user ${client.userId}`);
    try {
      deps.storage.deleteUserSession(client.userId);
    } catch (e) {
      logger.error("session clean error", { error: e });
    }
  };
  server.onExpiredClient = cleanup("old");
  server.onDisconnect = cleanup("closed");
  if (secure) {
    server.userHandler = handleUserPacket;
  }

  const address = await server.listen();
  return { server, address };
}
