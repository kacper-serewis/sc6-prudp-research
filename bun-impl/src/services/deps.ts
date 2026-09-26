import type { StreamCall } from "../quazal/prudp/server";
import { RmcError, RmcErrorKind } from "../quazal/rmc/error";
import type { Storage } from "../storage/storage";

/** Everything the protocol implementations need besides the request. */
export interface ServiceDeps {
  storage: Storage;
  /** Directory with the optional `news.json` and `challenges.json` overrides. */
  dataDir: string;
}

/** Principal id of the servers, handed out in tickets and connection data. */
export const SERVER_PID = 0x1000;

/** Runs a storage operation, turning failures into an `InternalError` (the `rmc_err!` macro). */
export function storageCall<T>(call: StreamCall, message: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    call.logger.error(message, { error: e });
    throw new RmcError(RmcErrorKind.InternalError, message);
  }
}
