/**
 * Database migrations, compatible with the `sqlx::migrate!` bookkeeping of the Rust server:
 * the same `_sqlx_migrations` table, versions, descriptions and SHA-384 checksums are used,
 * so both servers can share one database file.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Logger } from "../logger";
import init from "./migrations/20230917230530_init.sql" with { type: "text" };
import addSample from "./migrations/20231129203012_add_sample.sql" with { type: "text" };
import invites from "./migrations/20231207005134_invites.sql" with { type: "text" };
import sessions from "./migrations/20231212002723_sessions.sql" with { type: "text" };
import userLogout from "./migrations/20240108010100_user_logout.sql" with { type: "text" };

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/** Same order, versions and descriptions (file name with `_` replaced by spaces) as sqlx. */
export const MIGRATIONS: Migration[] = [
  { version: 20230917230530, description: "init", sql: init },
  { version: 20231129203012, description: "add sample", sql: addSample },
  { version: 20231207005134, description: "invites", sql: invites },
  { version: 20231212002723, description: "sessions", sql: sessions },
  { version: 20240108010100, description: "user logout", sql: userLogout },
];

const checksum = (sql: string) => createHash("sha384").update(sql).digest();

export function migrate(db: Database, logger: Logger, migrations = MIGRATIONS) {
  db.run(`
    CREATE TABLE IF NOT EXISTS _sqlx_migrations (
      version BIGINT PRIMARY KEY,
      description TEXT NOT NULL,
      installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      success BOOLEAN NOT NULL,
      checksum BLOB NOT NULL,
      execution_time BIGINT NOT NULL
    );
  `);

  const applied = new Map(
    db
      .query<{ version: number; checksum: Uint8Array; success: number }, []>(
        "SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version",
      )
      .all()
      .map((row) => [row.version, row]),
  );

  for (const row of applied.values()) {
    if (!row.success) {
      throw new Error(`migration ${row.version} is partially applied; fix and remove the row from _sqlx_migrations`);
    }
  }

  for (const migration of migrations) {
    const sum = checksum(migration.sql);
    const row = applied.get(migration.version);
    if (row) {
      if (!Buffer.from(row.checksum).equals(sum)) {
        logger.warn(`migration ${migration.version} (${migration.description}) was applied with a different checksum`);
      }
      continue;
    }
    const start = process.hrtime.bigint();
    db.transaction(() => {
      db.run(migration.sql);
      db.run(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, TRUE, ?, ?)",
        [migration.version, migration.description, sum, Number(process.hrtime.bigint() - start)],
      );
    })();
    logger.info(`Applied migration ${migration.version} (${migration.description})`);
  }
}
