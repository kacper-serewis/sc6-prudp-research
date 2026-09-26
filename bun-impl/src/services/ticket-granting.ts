/**
 * TicketGrantingProtocol of the authentication service (port of `dedicated_server/src/ticket.rs`).
 */
import { randomBytes } from "node:crypto";
import { TicketGrantingProtocol } from "../protocols/authentication-foundation/ticket-granting-protocol";
import type { RVConnectionData } from "../protocols/authentication-foundation/types";
import { UbiAuthenticationLoginCustomData } from "../protocols/ubi-authentication/types";
import type { Context } from "../quazal/context";
import { encodeKerberosTicket, SESSION_KEY_SIZE, type KerberosTicket } from "../quazal/kerberos";
import type { StreamCall } from "../quazal/prudp/server";
import { RmcError, RmcErrorKind } from "../quazal/rmc/error";
import { decodeParameters, implementProtocol } from "../quazal/rmc/protocol";
import { QRESULT_OK, StationURL } from "../quazal/types";
import { SERVER_PID, storageCall, storageCallAsync, type ServiceDeps } from "./deps";

const VALID_FOREVER = 0xffff_ffff_ffff_ffffn;

/** Where clients continue after logging in: the secure service, or this service if there is none. */
export function connectionData(ctx: Context, pid: number): RVConnectionData {
  const url = ctx.secureServerAddr
    ? `prudps:/address=${ctx.secureServerAddr.host};port=${ctx.secureServerAddr.port};CID=1;PID=${pid};sid=1;stream=3;type=2`
    : `prudp:/address=${ctx.listen.host};port=${ctx.listen.port};CID=1;PID=${pid};sid=2;stream=3;type=2`;
  return { urlRegularProtocols: StationURL.parse(url), lstSpecialProtocols: [], urlSpecialProtocols: new StationURL() };
}

export function ticketGrantingProtocol({ storage }: ServiceDeps) {
  /** A fresh session key, stored as the user's session. */
  function sessionKey(call: StreamCall, userId: number) {
    const key = randomBytes(SESSION_KEY_SIZE);
    try {
      storage.createUserSession(userId, key);
    } catch (e) {
      call.logger.error(`Error saving user session: ${(e as Error).message}`);
    }
    return key;
  }

  function ticket(call: StreamCall, userId: number, servicePid: number, password: string | undefined) {
    const key = sessionKey(call, userId);
    const kerberos: KerberosTicket = {
      sessionKey: key,
      pid: servicePid,
      internal: { principleId: userId, validUntil: VALID_FOREVER, sessionKey: key },
    };
    return encodeKerberosTicket(kerberos, userId, password, call.ctx.ticketKey);
  }

  return implementProtocol(TicketGrantingProtocol, {
    /**
     * Password-less login, used by the game for the built-in `Tracking` account. The ticket is
     * encrypted with the account's plaintext password, so only clients knowing it can use it.
     *
     * Deviation from the Rust server: accounts without a plaintext password (everyone registered
     * through the API) are refused. Upstream encrypts their ticket with the public default
     * password, which would let anyone log in as them.
     */
    login(request, call) {
      const userId = storageCall(call, "Error finding user", () => storage.findUserIdByName(request.strUserName));
      if (userId === undefined) {
        call.logger.warn(`user ${request.strUserName} not found`);
        throw new RmcError(RmcErrorKind.AccessDenied);
      }
      const password = storageCall(call, "Error finding user password", () => storage.findPasswordForUser(userId));
      if (password === undefined) {
        call.logger.warn(`user ${request.strUserName} has no plaintext password, use LoginEx`);
        throw new RmcError(RmcErrorKind.AccessDenied);
      }
      call.client.userId = userId;
      return {
        returnValue: QRESULT_OK,
        pidPrincipal: userId,
        pbufResponse: ticket(call, userId, SERVER_PID, password),
        pConnectionData: connectionData(call.ctx, 2),
        strReturnMsg: "",
      };
    },

    async loginEx(request, call) {
      const { typeName, data } = request.oExtraData;
      if (typeName !== "UbiAuthenticationLoginCustomData") {
        call.logger.error(`Unexpected login data ${typeName}`);
        throw new RmcError(RmcErrorKind.ParsingError, `unknown class ${typeName}`);
      }
      const { userName, password } = decodeParameters(UbiAuthenticationLoginCustomData, data);
      call.logger.info(`LoginEx attempt by ${userName} (${request.strUserName})`);

      // Argon2 verification runs on a worker thread, so other clients aren't blocked meanwhile.
      const result = await storageCallAsync(call, "Error logging in", () => storage.loginUserAsync(userName, password));
      if (!result.ok) {
        call.logger.warn(`login failed for ${userName}`);
        throw new RmcError(RmcErrorKind.AccessDenied);
      }
      call.logger.info(`login successful for ${userName}`);

      call.client.userId = result.userId;
      return {
        returnValue: QRESULT_OK,
        pidPrincipal: result.userId,
        pbufResponse: ticket(call, result.userId, SERVER_PID, undefined),
        pConnectionData: connectionData(call.ctx, SERVER_PID),
        strReturnMsg: "",
      };
    },

    requestTicket(request, call) {
      const { idSource: userId, idTarget: serverId } = request;
      if (call.client.userId !== userId) {
        call.logger.warn(`Ticket request for ${userId} to ${serverId} denied (user: ${call.client.userId})`);
        throw new RmcError(RmcErrorKind.AccessDenied);
      }
      const password = storageCall(call, "Error finding user password", () => storage.findPasswordForUser(userId));
      return { returnValue: QRESULT_OK, bufResponse: ticket(call, userId, serverId, password) };
    },
  });
}
