import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Logger, parseLevel, silentLogger, TerminalSink } from "../src/logger";
import { splinterCellBlacklistContext } from "../src/quazal/context";
import { startQuazalServer } from "../src/server";
import { Storage } from "../src/storage/storage";

/** Set TEST_LOG=debug to see server logs. */
export const testLogger = process.env.TEST_LOG ? new Logger([new TerminalSink(parseLevel(process.env.TEST_LOG))]) : silentLogger;

export const DATA_DIR = join(import.meta.dir, "..", "data");

/** Starts an authentication and a secure service on ephemeral ports with a fresh database. */
export async function startTestServers(options: { dataDir?: string } = {}) {
  const storage = new Storage(new Database(":memory:"), testLogger);
  storage.invalidateSessions();
  const deps = { storage, dataDir: options.dataDir ?? DATA_DIR };
  const ticketKey = randomBytes(32);

  const secure = await startQuazalServer(
    testLogger.child({ service: "sc_bl_secure" }),
    splinterCellBlacklistContext({
      listen: { host: "127.0.0.1", port: 0 },
      ticketKey,
      settings: new Map([
        ["storage_host", "127.0.0.1:8000"],
        ["storage_path", "/mp_balancing.ini"],
      ]),
    }),
    deps,
    true,
  );
  const auth = await startQuazalServer(
    testLogger.child({ service: "sc_bl_auth" }),
    splinterCellBlacklistContext({ listen: { host: "127.0.0.1", port: 0 }, ticketKey, secureServerAddr: secure.address }),
    deps,
    false,
  );

  return {
    storage,
    auth,
    secure,
    ctx: splinterCellBlacklistContext(),
    close() {
      auth.server.close();
      secure.server.close();
      storage.close();
    },
  };
}
