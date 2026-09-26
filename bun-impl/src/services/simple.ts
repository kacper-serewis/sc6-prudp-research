/**
 * Protocols that return fixed data (ports of `challenge.rs`, `clan.rs`, `ladder.rs`, `locale.rs`,
 * `privileges.rs`, `uplay_win.rs`, `tracking.rs` and `tracking_ext.rs`).
 */
import { ChallengeHelperProtocol } from "../protocols/challenge-helper-service/challenge-helper-protocol";
import { ClanHelperProtocol } from "../protocols/clan-helper-service/clan-helper-protocol";
import { LadderHelperProtocol } from "../protocols/ladder-helper-service/ladder-helper-protocol";
import { LocalizationProtocol } from "../protocols/localization-service/localization-protocol";
import { PrivilegesProtocol } from "../protocols/privileges-service/privileges-protocol";
import { TrackingProtocol3 } from "../protocols/tracking-service/tracking-protocol-3";
import { TrackingExtensionProtocol } from "../protocols/trackingextension/tracking-extension-protocol";
import { UplayWinProtocol } from "../protocols/uplay-win-service/uplay-win-protocol";
import type { StreamCall } from "../quazal/prudp/server";
import { implementProtocol, loginRequired } from "../quazal/rmc/protocol";

export function challengeHelperProtocol() {
  return implementProtocol(ChallengeHelperProtocol, {
    generateFriendChallenges(_request, call) {
      loginRequired(call);
      return { result: [] };
    },
  });
}

export function clanHelperProtocol() {
  return implementProtocol(ClanHelperProtocol, {
    getClanInfoByPid(_request, call) {
      loginRequired(call);
      return { clanInfo: { clid: 0xffff_ffff, tag: "TEST", title: "FOO", motto: "BAR" } };
    },
    generateClanChallenges(_request, call) {
      loginRequired(call);
      return { result: [] };
    },
    getMemberListByClid(_request, call) {
      loginRequired(call);
      return { members: [1002] };
    },
  });
}

export function ladderHelperProtocol() {
  return implementProtocol(LadderHelperProtocol, {
    getUnixUtc(_request, call) {
      loginRequired(call);
      return { time: Math.floor(Date.now() / 1000) };
    },
  });
}

export function localizationProtocol() {
  return implementProtocol(LocalizationProtocol, {
    setLocaleCode(request, call) {
      loginRequired(call);
      call.logger.debug(`setting locale to ${request.localCode}`);
      return {};
    },
  });
}

export function privilegesProtocol() {
  return implementProtocol(PrivilegesProtocol, {
    getPrivileges(_request, call) {
      loginRequired(call);
      return { privileges: new Map([[1, { id: 1, description: "PlayOnline" }]]) };
    },
  });
}

export function uplayWinProtocol() {
  return implementProtocol(UplayWinProtocol, {
    uplayWelcome(_request, call) {
      loginRequired(call);
      return { actionList: [] };
    },
    getActionsCompleted(_request, call) {
      loginRequired(call);
      return { actionList: [] };
    },
    getRewardsPurchased(_request, call) {
      loginRequired(call);
      return { rewardList: [] };
    },
  });
}

/**
 * Tags the game should send tracking events for. The Rust server only returns them when built
 * with the `tracking` feature; here the `tracking = "true"` service setting enables them.
 */
const TRACKING_TAGS = [
  "ADVCLIENT_STOP", "ADVCTIOBJECTIVE_EVENT", "ADVFRONTLINEOBJ_EVENT", "ADVHACKING_EVENT", "ADVRESPAWN_EVENT",
  "ADVROUND_FINISH", "ADVROUND_START", "ADVSPAWNLOCATION_EVENT", "ADVSPAWNVIS", "ADVXP_GAINED", "BLACKBOX_STOP",
  "CINEMATIC_STOP", "GADGET_EXPLOSION", "GADGED_USED", "GAME_START", "GAME_STOP", "LEVEL_END", "LEVEL_START",
  "LINKAPP_VIEW", "LOBBY_ENTER", "LOBBY_EXITHOST", "LOBBY_EXITCLIENT", "PLAYERBULLET_EVENT", "PLAYER_DEATH",
  "PLAYER_DETECT", "PLAYER_HOSTAGE", "PLAYER_KILL", "PLAYER_LOADOUT", "PLAYER_MARK", "PLAYER_POS", "PLAYER_REVIVE",
  "TX_SPEND", "UPLAY_START", "UPLAY_STOP", "WAVE_STOP", "ADV_BUGREPORT", "ADVCTIFLAG_POS", "UPLAY_PASS", "MENU_PASS",
  "UPLAY_ACCOUNT", "UPLAY_ACCOUNT_MENU", "STOREACTION", "SHADOWNET", "GAME_LOC", "PC_SPECS", "LOBBY_COMPLETE",
  "FPSCLIENT_START", "FPSCLIENT_STOP", "LEVEL_STOP", "OBJECTIVE_START", "OBJECTIVE_STOP", "UPLAY_BROWSE",
  "AWARD_UNLOCK", "GAME_SAVE", "INSTALL_START", "INSTALL_STOP", "MENU_ENTER", "MENU_EXIT", "MENU_OPTIONCHANGE",
  "MM_RES", "PLAYER_SAVED", "UNINSTALL_START", "UNINSTALL_STOP", "VIDEO_START", "VIDEO_STOP", "BLACKBOX_END",
  "PLAYER_DOWN", "COMBO_END",
];

const USER_GROUP_TRACKING_TAGS = [
  "GAME_START", "ADVCLIENT_STOP", "LEVEL_START", "LEVEL_STOP", "TX_SPEND", "LOBBY_ENTER", "LOBBY_EXITHOST",
  "LOBBY_EXITCLIENT", "AWARD_UNLOCK", "GAME_LOC", "PC_SPECS", "UPLAY_PASS", "MENU_PASS", "UPLAY_ACCOUNT",
  "UPLAY_ACCOUNT_MENU",
].map((tag) => `${tag}\0`);

const trackingEnabled = (call: StreamCall) => call.ctx.settings.get("tracking") === "true";

export function trackingProtocol() {
  return implementProtocol(TrackingProtocol3, {
    getConfiguration(_request, call) {
      loginRequired(call);
      return { tags: trackingEnabled(call) ? TRACKING_TAGS : [] };
    },
    sendTags(_request, call) {
      loginRequired(call);
      return {};
    },
  });
}

export function trackingExtensionProtocol() {
  return implementProtocol(TrackingExtensionProtocol, {
    getTrackingUserGroup(_request, call) {
      loginRequired(call);
      return { usergroup: 0 };
    },
    getTrackingUserGroupTags(_request, call) {
      loginRequired(call);
      return { tags: trackingEnabled(call) ? USER_GROUP_TRACKING_TAGS : [] };
    },
  });
}
