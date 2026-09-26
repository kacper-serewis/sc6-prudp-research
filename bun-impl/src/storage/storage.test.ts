import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { silentLogger } from "../logger";
import { MIGRATIONS } from "./migrations";
import { isUniqueViolation, Storage } from "./storage";

const open = () => new Storage(new Database(":memory:"), silentLogger);

describe("Storage", () => {
  test("records migrations like sqlx", () => {
    const storage = open();
    const rows = storage.db
      .query<{ version: number; description: string; checksum: Uint8Array; success: number }, []>(
        "SELECT version, description, checksum, success FROM _sqlx_migrations ORDER BY version",
      )
      .all();
    expect(rows.map((r) => [r.version, r.description])).toEqual(MIGRATIONS.map((m) => [m.version, m.description]));
    for (const [i, row] of rows.entries()) {
      expect(row.success).toBe(1);
      expect(Buffer.from(row.checksum)).toEqual(createHash("sha384").update(MIGRATIONS[i].sql).digest());
    }
    // Running the migrations again is a no-op.
    expect(() => new Storage(storage.db, silentLogger)).not.toThrow();
  });

  test("logs in the seeded accounts", () => {
    const storage = open();
    expect(storage.loginUser("sam_the_fisher", "password1234")).toEqual({ ok: true, userId: 1002 });
    expect(storage.loginUser("sam_the_fisher", "nope")).toEqual({ ok: false, error: "InvalidPassword" });
    expect(storage.loginUser("Tracking", "JaDe!")).toEqual({ ok: true, userId: 105 });
    expect(storage.loginUser("nobody", "x")).toEqual({ ok: false, error: "NotFound" });
    expect(() => storage.loginUser("Server", "x")).toThrow("neither password or password_hash");
    expect(storage.findPasswordForUser(105)).toBe("JaDe!");
    expect(storage.findPasswordForUser(1002)).toBeUndefined();
  });

  test("registers users with argon2 hashes and rejects duplicates", () => {
    const storage = open();
    storage.registerUser("newbie", "secret", "NEWBIE");
    const id = storage.findUserIdByName("newbie")!;
    expect(storage.loginUser("newbie", "secret")).toEqual({ ok: true, userId: id });
    expect(storage.findUserIdByUbiId("NEWBIE")).toBe(id);
    expect(storage.findUbiIdByUserId(id)).toBe("NEWBIE");
    expect(storage.findUserByUbiId("NEWBIE")).toMatchObject({ id, username: "newbie", isOnline: false });
    let error: unknown;
    try {
      storage.registerUser("newbie", "other", "OTHER");
    } catch (e) {
      error = e;
    }
    expect(isUniqueViolation(error)).toBe(true);
  });

  test("manages game sessions, participants and station urls", () => {
    const storage = open();
    storage.invalidateSessions();
    const sessionId = storage.createGameSession(1002, 1, "101 => 5;102 => 3");
    storage.addParticipants(1, sessionId, [1002], [1000]);
    storage.registerUrls(1002, ["prudp:/address=1.2.3.4;port=3074;type=2"]);
    storage.registerUrls(1000, ["prudp:/address=5.6.7.8;port=3074;type=2"]);

    expect(storage.searchSessions(1, 1002)).toEqual([]);
    const [found] = storage.searchSessions(1, 1000);
    expect(found).toMatchObject({ sessionType: 1, sessionId, creatorId: 1002, attributes: "101 => 5;102 => 3" });
    // The order is SQLite's join order (by user id), same as with the Rust server's query.
    expect(found.participants).toEqual([
      { userId: 1000, name: "Foo", stationUrls: [] },
      { userId: 1002, name: "sam_the_fisher", stationUrls: ["prudp:/address=1.2.3.4;port=3074;type=2"] },
    ]);
    expect(storage.searchSessionsWithParticipants(1, [1000]).map((s) => s.sessionId)).toEqual([sessionId]);

    storage.removeParticipants(1, sessionId, [1000]);
    expect(storage.listGameSessions()[0].participants.map((p) => p.userId)).toEqual([1002]);

    expect(storage.deleteGameSession(1000, 1, sessionId)).toBe(0);
    expect(storage.deleteGameSession(1002, 1, sessionId)).toBe(1);
    expect(storage.listGameSessions()).toEqual([]);
  });

  test("user sessions and invites", () => {
    const storage = open();
    storage.invalidateSessions();
    storage.createUserSession(1002, Buffer.alloc(16, 0xab));
    expect(storage.findUserById(1002)?.isOnline).toBe(true);
    storage.registerUrls(1002, ["udp:/address=1.1.1.1;port=1"]);
    storage.deleteUserSession(1002);
    expect(storage.listUrls(1002)).toEqual([]);

    storage.addInvite(1001, 1002);
    storage.addInvite(1000, 1002);
    expect(storage.takeInvite(1002)).toMatchObject({ sender: 1001, receiver: 1002 });
    expect(storage.takeInvite(1002)).toMatchObject({ sender: 1000, receiver: 1002 });
    expect(storage.takeInvite(1002)).toBeUndefined();
  });
});
