// Ticket granting protocol (protocol 10) types — mirrors
// dedicated_server/sc_bl_protocols/src/protocols/authentication_foundation.
import { type Infer, list, qbuffer, qstring, qstruct, u32, u8 } from "../quazal/rmc/basic";
import { anyData, qresult, stationUrl } from "../quazal/rmc/types";

export const TICKET_GRANTING_PROTOCOL_ID = 10;

export enum TicketGrantingProtocolMethod {
  Login = 1,
  LoginEx = 2,
  RequestTicket = 3,
  GetPid = 4,
  GetName = 5,
  LoginWithContext = 6,
}

export const RVConnectionData = qstruct({
  urlRegularProtocols: stationUrl,
  lstSpecialProtocols: list(u8),
  urlSpecialProtocols: stationUrl,
});
export type RVConnectionData = Infer<typeof RVConnectionData>;

export const LoginExRequest = qstruct({
  strUserName: qstring,
  oExtraData: anyData,
});
export type LoginExRequest = Infer<typeof LoginExRequest>;

// The Rust struct has a leading `data: quazal::rmc::types::Data` field, a unit
// struct that serializes to zero bytes — omitted here.
export const UbiAuthenticationLoginCustomData = qstruct({
  userName: qstring,
  onlineKey: qstring,
  password: qstring,
});
export type UbiAuthenticationLoginCustomData = Infer<typeof UbiAuthenticationLoginCustomData>;

export const LoginExResponse = qstruct({
  returnValue: qresult,
  pidPrincipal: u32,
  pbufResponse: qbuffer,
  pConnectionData: RVConnectionData,
  strReturnMsg: qstring,
});
export type LoginExResponse = Infer<typeof LoginExResponse>;
