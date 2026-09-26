/** SecureConnectionProtocol (port of `dedicated_server/src/secure.rs`). */
import { SecureConnectionProtocol } from "../protocols/secure-connection-service/secure-connection-protocol";
import type { StreamCall } from "../quazal/prudp/server";
import { RmcError, RmcErrorKind } from "../quazal/rmc/error";
import { implementProtocol, loginRequired } from "../quazal/rmc/protocol";
import { QRESULT_OK, StationURL } from "../quazal/types";

/** The address the client is seen from. */
function publicUrl(call: StreamCall, sid: number, type: number) {
  const { host, port } = call.client.address;
  return StationURL.parse(`prudp:/address=${host};port=${port};sid=${sid};type=${type}`);
}

/** Assigned when the client connected with its ticket, i.e. together with the user id. */
function connectionId(call: StreamCall) {
  if (call.client.connectionId === undefined) {
    throw new RmcError(RmcErrorKind.InternalError, "client has no connection id");
  }
  return call.client.connectionId;
}

export function secureConnectionProtocol() {
  return implementProtocol(SecureConnectionProtocol, {
    register(request, call) {
      loginRequired(call);
      call.logger.info("Client registers", { urls: request.vecMyUrls.map(String) });
      return { returnValue: QRESULT_OK, pidConnectionId: connectionId(call), urlPublic: publicUrl(call, 14, 2) };
    },

    registerEx(request, call) {
      loginRequired(call);
      call.logger.info("Client registers", { urls: request.vecMyUrls.map(String), customData: request.hCustomData.typeName });
      return { returnValue: QRESULT_OK, pidConnectionId: connectionId(call), urlPublic: publicUrl(call, 15, 3) };
    },
  });
}
