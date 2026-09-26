/**
 * GameSessionProtocol and GameSessionExProtocol (ports of `game_session.rs` and `game_session_ex.rs`).
 *
 * Session attributes are stored as `id => value;...` text. Some known ids:
 * 101 map, 102 game mode, 103 distinguishes Spy vs Merc from coop searches, 105 game type
 * (1 SvM, 2 coop), 112 player count related.
 */
import { GameSessionExProtocol } from "../protocols/game-session-ex-service/game-session-ex-protocol";
import type { GameSessionSearchResultEx } from "../protocols/game-session-ex-service/types";
import { GameSessionProtocol } from "../protocols/game-session-service/game-session-protocol";
import type { GameSessionSearchWithParticipantsResult } from "../protocols/game-session-service/types";
import { implementProtocol, loginRequired } from "../quazal/rmc/protocol";
import { formatProperties, parseProperties, StationURL } from "../quazal/types";
import type { GameSession } from "../storage/storage";
import { storageCall, type ServiceDeps } from "./deps";

const parseUrls = (urls: string[]) => urls.map((url) => StationURL.parse(url));

export function gameSessionProtocol({ storage }: ServiceDeps) {
  return implementProtocol(GameSessionProtocol, {
    createSession(request, call) {
      call.logger.info("Client creates session", { request });
      const userId = loginRequired(call);
      const { typeId, attributes } = request.gameSession;
      const sessionId = storageCall(call, "error creating game session", () =>
        storage.createGameSession(userId, typeId, formatProperties(attributes)),
      );
      return { gameSessionKey: { typeId, sessionId } };
    },

    updateSession(request, call) {
      loginRequired(call);
      call.logger.info("Client updates session", { request });
      const { sessionKey, attributes } = request.gameSessionUpdate;
      storageCall(call, "error updating game session", () =>
        storage.updateGameSession(sessionKey.typeId, sessionKey.sessionId, formatProperties(attributes)),
      );
      return {};
    },

    deleteSession(request, call) {
      const userId = loginRequired(call);
      const { typeId, sessionId } = request.gameSessionKey;
      const deleted = storageCall(call, "error deleting session", () => storage.deleteGameSession(userId, typeId, sessionId));
      if (deleted !== 1) {
        call.logger.warn("Unexpected amount of sessions deleted");
      }
      return {};
    },

    leaveSession(_request, call) {
      loginRequired(call);
      return {};
    },

    addParticipants(request, call) {
      loginRequired(call);
      call.logger.info("Client adds participants", { request });
      const { typeId, sessionId } = request.gameSessionKey;
      storageCall(call, "error adding participants", () =>
        storage.addParticipants(typeId, sessionId, request.privateParticipantIds, request.publicParticipantIds),
      );
      return {};
    },

    removeParticipants(request, call) {
      loginRequired(call);
      call.logger.info("Client removes participants", { request });
      const { typeId, sessionId } = request.gameSessionKey;
      storageCall(call, "error removing participants", () =>
        storage.removeParticipants(typeId, sessionId, request.participantIds),
      );
      return {};
    },

    abandonSession(_request, call) {
      loginRequired(call);
      return {};
    },

    registerUrls(request, call) {
      const userId = loginRequired(call);
      call.logger.info("Client registers urls", { urls: request.stationUrls.map(String) });
      storageCall(call, "error registering urls", () =>
        storage.registerUrls(userId, request.stationUrls.map((url) => url.toString())),
      );
      return {};
    },

    searchSessionsWithParticipants(request, call) {
      loginRequired(call);
      call.logger.info("Searches for sessions", { request });
      const sessions = storageCall(call, "Error searching game sessions", () =>
        storage.searchSessionsWithParticipants(request.gameSessionTypeId, request.participantIds),
      );
      call.logger.info("Found sessions", { sessions });

      const searchResults = sessions.flatMap((session): GameSessionSearchWithParticipantsResult[] => {
        const host = session.participants.find((p) => p.userId === session.creatorId);
        if (!host) {
          // The Rust server panics here; skipping the session keeps everyone else connected.
          call.logger.warn(`host of session ${session.sessionId} is not a participant`);
          return [];
        }
        return [
          {
            gameSessionSearchResult: {
              sessionKey: { typeId: session.sessionType, sessionId: session.sessionId },
              hostPid: host.userId,
              hostUrls: parseUrls(host.stationUrls),
              attributes: parseProperties(session.attributes),
            },
            participantIds: session.participants.map((p) => p.userId),
          },
        ];
      });
      return { searchResults };
    },

    splitSession(request, call) {
      loginRequired(call);
      return { gameSessionKeyMigrated: request.gameSessionKey };
    },

    joinSession() {
      return {};
    },
  });
}

/** Attribute ids that have to match, 103 defaults to 0 to keep coop and Spy vs Merc sessions apart. */
function matchesQuery(session: GameSession, query: Map<number, number>) {
  const attributes = new Map(parseProperties(session.attributes).map((p) => [p.id, p.value]));
  for (const [id, value] of query) {
    // The search asks for 1, but sessions are created with 2. Ignore it to find them anyway.
    if (id === 112) {
      continue;
    }
    if (attributes.get(id) !== value) {
      return false;
    }
  }
  return true;
}

export function gameSessionExProtocol({ storage }: ServiceDeps) {
  return implementProtocol(GameSessionExProtocol, {
    searchSessions(request, call) {
      const userId = loginRequired(call);
      call.logger.info("Client searches for session", { request });
      const { typeId, parameters } = request.gameSessionQuery;
      const sessions = storageCall(call, "Error searching game sessions", () => storage.searchSessions(typeId, userId));

      const query = new Map(parameters.map((p) => [p.id, p.value]));
      if (!query.has(103)) {
        query.set(103, 0);
      }
      const found = sessions.filter((session) => matchesQuery(session, query));
      call.logger.info("Found sessions", { sessions: found });

      return {
        searchResults: found.map(
          (session): GameSessionSearchResultEx => ({
            gameSessionSearchResult: {
              sessionKey: { typeId: session.sessionType, sessionId: session.sessionId },
              hostPid: session.creatorId,
              hostUrls: parseUrls(
                session.participants.filter((p) => p.userId === session.creatorId).flatMap((p) => p.stationUrls),
              ),
              attributes: parseProperties(session.attributes),
            },
            participants: session.participants.map((p) => ({
              pid: p.userId,
              name: p.name,
              stationUrls: parseUrls(p.stationUrls),
            })),
          }),
        ),
      };
    },
  });
}
