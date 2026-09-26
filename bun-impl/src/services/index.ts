import type { Protocol } from "../quazal/rmc/protocol";
import { playerStatsProtocol, ubiAccountManagementProtocol, userStorageProtocol } from "./accounts";
import type { ServiceDeps } from "./deps";
import { gameSessionExProtocol, gameSessionProtocol } from "./game-session";
import { natTraversalProtocol } from "./nat-traversal";
import { overlordChallengeProtocol, overlordCoreProtocol, overlordNewsProtocol } from "./overlord";
import { secureConnectionProtocol } from "./secure-connection";
import {
  challengeHelperProtocol,
  clanHelperProtocol,
  ladderHelperProtocol,
  localizationProtocol,
  privilegesProtocol,
  trackingExtensionProtocol,
  trackingProtocol,
  uplayWinProtocol,
} from "./simple";
import { ticketGrantingProtocol } from "./ticket-granting";

export type { ServiceDeps } from "./deps";

/** Protocols of the authentication service (`sc_bl_auth`). */
export function authenticationProtocols(deps: ServiceDeps): Protocol[] {
  return [ticketGrantingProtocol(deps)];
}

/** Protocols of the secure service (`sc_bl_secure`). */
export function secureProtocols(deps: ServiceDeps): Protocol[] {
  return [
    challengeHelperProtocol(),
    clanHelperProtocol(),
    gameSessionExProtocol(deps),
    gameSessionProtocol(deps),
    ladderHelperProtocol(),
    localizationProtocol(),
    natTraversalProtocol(),
    overlordChallengeProtocol(deps),
    overlordCoreProtocol(),
    overlordNewsProtocol(deps),
    playerStatsProtocol(),
    privilegesProtocol(),
    secureConnectionProtocol(),
    trackingExtensionProtocol(),
    trackingProtocol(),
    ubiAccountManagementProtocol(deps),
    uplayWinProtocol(),
    userStorageProtocol(),
  ];
}
