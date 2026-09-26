/**
 * SQLite storage for users, sessions, game sessions and invites (port of the Rust `storage` module).
 */
import { Database } from "bun:sqlite";
import type { Logger } from "../logger";
import { migrate } from "./migrations";

export interface User {
  id: number;
  username: string;
  ubiId: string | null;
  isOnline: boolean;
}

export interface Participant {
  userId: number;
  name: string;
  stationUrls: string[];
}

export interface GameSession {
  sessionType: number;
  sessionId: number;
  creatorId: number;
  attributes: string;
  participants: Participant[];
}

export interface Invite {
  id: number;
  sender: number;
  receiver: number;
}

export type LoginResult = { ok: true; userId: number } | { ok: false; error: "NotFound" | "InvalidPassword" };

/** Same Argon2 parameters as the defaults of the `argon2` crate used by the Rust server. */
const ARGON2 = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;

export function isUniqueViolation(error: unknown) {
  return (error as { code?: string })?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

interface UserRow {
  id: number;
  username: string;
  ubi_id: string | null;
  is_online: number | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  ubiId: row.ubi_id,
  isOnline: Boolean(row.is_online),
});

interface SessionRow {
  session_type: number;
  session_id: number;
  creator_id: number;
  attributes: string | null;
}

export class Storage {
  constructor(
    readonly db: Database,
    private readonly logger: Logger,
  ) {
    db.run("PRAGMA foreign_keys=ON");
    migrate(db, logger);
  }

  /** Opens (and creates) the database file, `5th-echelon.db` like the Rust server by default. */
  static open(logger: Logger, path = "5th-echelon.db") {
    return new Storage(new Database(path, { create: true }), logger);
  }

  close() {
    this.db.close();
  }

  /** Looks up the stored password or hash of a user (exactly one of them is set). */
  private findCredentials(username: string) {
    const row = this.db
      .query<{ id: number; password: string | null; password_hash: string | null }, [string]>(
        "SELECT id, password, password_hash FROM users WHERE username = ?",
      )
      .get(username);
    if (!row) {
      this.logger.warn(`User ${username} not found`);
      return undefined;
    }
    if (row.password !== null && row.password_hash !== null) {
      throw new Error(`password and password_hash set for user ${row.id}`);
    }
    if (row.password === null && row.password_hash === null) {
      throw new Error(`neither password or password_hash set for user ${row.id}`);
    }
    this.logger.info(`Verify ${row.password !== null ? "plain password" : "password hash"} of ${username}`);
    return row as { id: number } & ({ password: string; password_hash: null } | { password: null; password_hash: string });
  }

  private finishLogin(userId: number, valid: boolean): LoginResult {
    if (!valid) {
      return { ok: false, error: "InvalidPassword" };
    }
    // Users only show up as online once the game creates a session (see `createUserSession`),
    // logging in through the API alone doesn't count. That's also how the Rust server behaves.
    this.db.run("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
    return { ok: true, userId };
  }

  /** Verifies the password synchronously; request handlers should use `loginUserAsync`. */
  loginUser(username: string, password: string): LoginResult {
    const row = this.findCredentials(username);
    if (!row) {
      return { ok: false, error: "NotFound" };
    }
    const valid = row.password !== null ? row.password === password : Bun.password.verifySync(password, row.password_hash);
    return this.finishLogin(row.id, valid);
  }

  /** Like `loginUser`, but verifies password hashes on Bun's worker threads instead of blocking. */
  async loginUserAsync(username: string, password: string): Promise<LoginResult> {
    const row = this.findCredentials(username);
    if (!row) {
      return { ok: false, error: "NotFound" };
    }
    const valid = row.password !== null ? row.password === password : await Bun.password.verify(password, row.password_hash);
    return this.finishLogin(row.id, valid);
  }

  registerUser(username: string, password: string, ubiId?: string | null) {
    this.insertUser(username, Bun.password.hashSync(password, ARGON2), ubiId);
  }

  /** Like `registerUser`, but hashes the password on Bun's worker threads instead of blocking. */
  async registerUserAsync(username: string, password: string, ubiId?: string | null) {
    this.insertUser(username, await Bun.password.hash(password, ARGON2), ubiId);
  }

  private insertUser(username: string, passwordHash: string, ubiId?: string | null) {
    this.db.run("INSERT INTO users (username, password_hash, ubi_id) VALUES (?, ?, ?)", [username, passwordHash, ubiId ?? null]);
  }

  /** The plaintext password of legacy accounts (used to encrypt their tickets), if there is one. */
  findPasswordForUser(userId: number) {
    return (
      this.db.query<{ password: string | null }, [number]>("SELECT password FROM users WHERE id = ?").get(userId)
        ?.password ?? undefined
    );
  }

  findUserByUbiId(ubiId: string) {
    const row = this.db
      .query<UserRow, [string]>("SELECT id, username, ubi_id, is_online FROM users WHERE ubi_id = ?")
      .get(ubiId);
    return row ? toUser(row) : undefined;
  }

  findUserById(id: number) {
    const row = this.db.query<UserRow, [number]>("SELECT id, username, ubi_id, is_online FROM users WHERE id = ?").get(id);
    return row ? toUser(row) : undefined;
  }

  findUserIdByName(username: string) {
    return this.db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)?.id;
  }

  findUbiIdByUserId(userId: number) {
    return this.db.query<{ ubi_id: string | null }, [number]>("SELECT ubi_id FROM users WHERE id = ?").get(userId)?.ubi_id ?? undefined;
  }

  findUsernameByUserId(userId: number) {
    return this.db.query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?").get(userId)?.username;
  }

  findUserIdByUbiId(ubiId: string) {
    return this.db.query<{ id: number }, [string]>("SELECT id FROM users WHERE ubi_id = ?").get(ubiId)?.id;
  }

  createUserSession(userId: number, key: Uint8Array) {
    this.db.transaction(() => {
      this.db.run("INSERT INTO user_sessions (id, user_id) VALUES (?, ?)", [
        Buffer.from(key).toString("hex").toUpperCase(),
        userId,
      ]);
      this.db.run("UPDATE users SET is_online=1 WHERE id=?", [userId]);
    })();
  }

  /** Cleans up after a client disconnected or expired. */
  deleteUserSession(userId: number) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM station_urls WHERE user_id = ?", [userId]);
      this.db.run("UPDATE game_sessions SET destroyed_at=CURRENT_TIMESTAMP WHERE creator_id = ?", [userId]);
      // Like the Rust server, users stay online: they may still be connected to the other service.
      this.db.run("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
    })();
  }

  /** Clears everything that belongs to connections, which don't survive a server restart. */
  invalidateSessions() {
    this.db.transaction(() => {
      this.db.run("DELETE FROM station_urls");
      this.db.run("DELETE FROM user_sessions");
      this.db.run("UPDATE game_sessions SET destroyed_at=CURRENT_TIMESTAMP WHERE destroyed_at IS NULL");
      this.db.run("UPDATE users SET is_online=0");
    })();
  }

  createGameSession(userId: number, typeId: number, attributes: string) {
    return Number(
      this.db.run("INSERT INTO game_sessions (type_id, creator_id, attributes) VALUES (?, ?, ?)", [
        typeId,
        userId,
        attributes,
      ]).lastInsertRowid,
    );
  }

  updateGameSession(typeId: number, gameId: number, attributes: string) {
    this.db.run("UPDATE game_sessions SET attributes = ? WHERE id = ? AND type_id = ?", [attributes, gameId, typeId]);
  }

  /** Open sessions of a type, excluding the ones created by `excludeUser`. */
  searchSessions(typeId: number, excludeUser?: number) {
    const rows =
      excludeUser === undefined
        ? this.db
            .query<SessionRow, [number]>(
              "SELECT type_id as session_type, id as session_id, creator_id, attributes FROM game_sessions WHERE type_id = ? AND destroyed_at IS NULL",
            )
            .all(typeId)
        : this.db
            .query<SessionRow, [number, number]>(
              "SELECT type_id as session_type, id as session_id, creator_id, attributes FROM game_sessions WHERE type_id = ? AND creator_id != ? AND destroyed_at IS NULL",
            )
            .all(typeId, excludeUser);
    // Station urls of the searching user are not needed, the game would try to connect to itself.
    return rows.map((row) => this.loadSession(row, excludeUser));
  }

  searchSessionsWithParticipants(typeId: number, participantIds: number[]) {
    if (participantIds.length === 0) {
      return [];
    }
    const placeholders = participantIds.map(() => "?").join(",");
    const rows = this.db
      .query<SessionRow, number[]>(
        `SELECT g.type_id as session_type, g.id as session_id, g.creator_id, g.attributes
         FROM game_sessions AS g
         WHERE type_id = ? AND destroyed_at IS NULL AND g.id IN (
           SELECT game_id FROM participants WHERE user_id IN (${placeholders})
         )`,
      )
      .all(typeId, ...participantIds);
    return rows.map((row) => this.loadSession(row));
  }

  listGameSessions() {
    const rows = this.db
      .query<SessionRow, []>(
        "SELECT type_id as session_type, id as session_id, creator_id, attributes FROM game_sessions WHERE destroyed_at IS NULL",
      )
      .all();
    return rows.map((row) => this.loadSession(row));
  }

  private loadSession(row: SessionRow, skipUrlsOf?: number): GameSession {
    const participants = this.db
      .query<{ user_id: number; name: string }, [number]>(
        "SELECT user_id, username as name FROM participants p, users u WHERE u.id = user_id AND game_id = ?",
      )
      .all(row.session_id)
      .map((p) => ({
        userId: p.user_id,
        name: p.name,
        stationUrls: p.user_id === skipUrlsOf ? [] : this.listUrls(p.user_id),
      }));
    return {
      sessionType: row.session_type,
      sessionId: row.session_id,
      creatorId: row.creator_id,
      attributes: row.attributes ?? "",
      participants,
    };
  }

  addParticipants(_typeId: number, sessionId: number, privateParticipants: number[], publicParticipants: number[]) {
    const userIds = [...privateParticipants, ...publicParticipants];
    if (userIds.length === 0) {
      this.logger.warn("Empty participant list");
      return;
    }
    this.db.run(
      `INSERT OR REPLACE INTO participants (game_id, user_id) VALUES ${userIds.map(() => "(?, ?)").join(", ")}`,
      userIds.flatMap((userId) => [sessionId, userId]),
    );
  }

  removeParticipants(_typeId: number, sessionId: number, participants: number[]) {
    const statement = this.db.query("DELETE FROM participants WHERE game_id = ? AND user_id = ?");
    for (const userId of participants) {
      statement.run(sessionId, userId);
    }
  }

  /** Returns the number of deleted sessions. */
  deleteGameSession(creatorId: number, typeId: number, sessionId: number) {
    return this.db.run(
      "UPDATE game_sessions SET destroyed_at=CURRENT_TIMESTAMP WHERE creator_id = ? AND type_id = ? AND id = ?",
      [creatorId, typeId, sessionId],
    ).changes;
  }

  deleteGameSessionById(sessionId: number) {
    this.db.run("UPDATE game_sessions SET destroyed_at=CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
  }

  registerUrls(userId: number, urls: string[]) {
    if (urls.length === 0) {
      this.logger.warn("Empty url list");
      return;
    }
    this.db.run(
      `INSERT OR REPLACE INTO station_urls (user_id, url) VALUES ${urls.map(() => "(?, ?)").join(", ")}`,
      urls.flatMap((url) => [userId, url]),
    );
  }

  listUrls(userId: number) {
    return this.db
      .query<{ url: string }, [number]>("SELECT url FROM station_urls WHERE user_id = ?")
      .all(userId)
      .map((row) => row.url);
  }

  /** Users with a Ubisoft id, i.e. everyone who can show up in friend lists. */
  listUsers() {
    return this.db
      .query<UserRow, []>("SELECT id, username, ubi_id, is_online FROM users WHERE ubi_id IS NOT NULL")
      .all()
      .map(toUser);
  }

  deleteUser(userId: number) {
    this.db.run("DELETE FROM users WHERE id = ?", [userId]);
  }

  addInvite(senderId: number, receiverId: number) {
    this.logger.info(`sending invite from ${senderId} to ${receiverId}`);
    return Number(this.db.run("INSERT INTO invites (sender, receiver) VALUES (?, ?)", [senderId, receiverId]).lastInsertRowid);
  }

  /** Removes and returns the oldest pending invite of a user. */
  takeInvite(userId: number): Invite | undefined {
    const invite = this.db
      .query<Invite, [number]>("SELECT rowid as id, sender, receiver FROM invites WHERE receiver = ?")
      .get(userId);
    if (invite) {
      this.db.run("DELETE FROM invites WHERE rowid = ?", [invite.id]);
    }
    return invite ?? undefined;
  }
}
