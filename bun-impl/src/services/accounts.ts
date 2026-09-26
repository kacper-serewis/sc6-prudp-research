/**
 * Account related protocols (ports of `ubi_acc_mgmt.rs`, `player_stats.rs` and `user_storage.rs`).
 */
import { PlayerStatsProtocol } from "../protocols/player-stats-service/player-stats-protocol";
import { UbiAccountManagementProtocol } from "../protocols/ubi-account-management-service/ubi-account-management-protocol";
import { UserStorageProtocol } from "../protocols/user-storage/user-storage-protocol";
import type { StreamCall } from "../quazal/prudp/server";
import { RmcError, RmcErrorKind } from "../quazal/rmc/error";
import { implementProtocol, loginRequired } from "../quazal/rmc/protocol";
import { Variant } from "../quazal/types";
import type { ServiceDeps } from "./deps";

/** Looks up every key, skipping unknown ones and logging storage errors (like the Rust `filter_map`). */
function lookup<K, V>(call: StreamCall, keys: K[], find: (key: K) => V | undefined) {
  const result = new Map<K, V>();
  for (const key of keys) {
    try {
      const value = find(key);
      if (value !== undefined) {
        result.set(key, value);
      }
    } catch (e) {
      call.logger.error("storage lookup failed", { error: e });
    }
  }
  return result;
}

export function ubiAccountManagementProtocol({ storage }: ServiceDeps) {
  return implementProtocol(UbiAccountManagementProtocol, {
    lookupPrincipalIds(request, call) {
      loginRequired(call);
      const pids = lookup(call, request.ubiAccountIds, (ubiId) => storage.findUserIdByUbiId(ubiId));
      call.logger.info(`Lookup requested for ${request.ubiAccountIds.length} ubi ids. Found ${pids.size}`, {
        requested: request.ubiAccountIds,
        found: pids,
      });
      return { pids };
    },

    lookupUbiAccountIdsByPids(request, call) {
      loginRequired(call);
      const ubiaccountIds = lookup(call, request.pids, (pid) => storage.findUbiIdByUserId(pid));
      call.logger.info(`Lookup requested for ${request.pids.length} pids. Found ${ubiaccountIds.size}`, {
        requested: request.pids,
        found: ubiaccountIds,
      });
      return { ubiaccountIds };
    },

    hasAcceptedLatestTos(_request, call) {
      loginRequired(call);
      return { hasAccepted: true, failedReasons: [] };
    },
  });
}

/** Stat ids with the value 1 the Rust server reports for every player (122 = wins is 1337). */
const PLAYER_STATS: [id: number, value: number][] = [
  [0x7e, 1],
  [0x7a, 1],
  [0x7c, 1],
  [0xc9, 1],
  [0xcc, 1],
  [0xcd, 1],
  [0xc8, 1],
  [122, 1337],
  [182, 1337],
];

export function playerStatsProtocol() {
  return implementProtocol(PlayerStatsProtocol, {
    readStatsByPlayers(request, call) {
      loginRequired(call);
      const [playerPid] = request.playerPids;
      if (playerPid === undefined) {
        throw new RmcError(RmcErrorKind.InternalError, "no player requested");
      }
      return {
        results: [
          {
            boardId: 1,
            contextId: 0,
            resetFrequency: 1,
            playerStatSets: [
              {
                playerPid,
                playerName: "foobar",
                submittedTime: 0x1f_9635_4343n,
                stats: PLAYER_STATS.map(([id, value]) => ({ id, value: Variant.i64(value) })),
              },
            ],
            defaultStatValues: [],
          },
        ],
      };
    },

    writeStats(_request, call) {
      loginRequired(call);
      return {};
    },
  });
}

export function userStorageProtocol() {
  return implementProtocol(UserStorageProtocol, {
    searchContents(request, call) {
      loginRequired(call);
      if (request.query.typeId !== 0x8000_0002) {
        return { searchResults: [] };
      }
      return {
        searchResults: [
          {
            key: { typeId: 0x8000_0002, contentId: 1n },
            pid: 0x0000_045f,
            properties: [
              { id: 6, value: Variant.i64(0x274) },
              { id: 4, value: Variant.datetime(0x1f768edbd6n) },
              { id: 5, value: Variant.datetime(0x1f768f13f9n) },
              { id: 7, value: Variant.string("A6E32CFD0C2B2CFFE2D0C785830B7C49") },
            ],
          },
        ],
      };
    },

    /** Points the game to the content service (settings `storage_host`, `storage_path`, `content_protocol`). */
    getContentUrl(_request, call) {
      loginRequired(call);
      const { settings } = call.ctx;
      const host = settings.get("storage_host");
      const path = settings.get("storage_path");
      if (host === undefined || path === undefined) {
        call.logger.error("missing storage_host or storage_path setting");
        throw new RmcError(RmcErrorKind.InternalError, "content storage is not configured");
      }
      return { downloadInfo: { protocol: settings.get("content_protocol") ?? "http://", host, path } };
    },
  });
}
