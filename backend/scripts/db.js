const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { DatabaseSetupError, databaseFailureCode } = require("../db/config");
const { logFailure } = require("../logging");
const { createPool } = require("../db/pool");
const { migrate, readMigrations } = require("../db/migrate");
const { seed } = require("../db/seed");

async function main() {
  const command = process.argv[2];
  if (!["migrate", "seed", "check"].includes(command)) {
    throw new DatabaseSetupError("Use npm run db:migrate, npm run db:seed or npm run db:check.");
  }
  const pool = createPool();
  try {
    if (command === "migrate") {
      const applied = await migrate(pool);
      console.log(applied.length ? `Applied ${applied.join(", ")}.` : "Schema is up to date; no migrations applied.");
    } else if (command === "seed") {
      const result = await seed(pool);
      console.log(`Seed fixtures verified: ${result.fixtureUsers} users, ${result.fixtureRooms} rooms, ${result.fixtureMemberships} memberships, ${result.fixtureMessages} messages (${result.insertedUsers} new users). Existing records preserved.`);
    } else {
      // Query the tables as well as SELECT 1: /api/ping does not prove DB readiness.
      await pool.query("SELECT 1");
      const { rows: applied } = await pool.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
      const expected = await readMigrations();
      if (applied.length !== expected.length || applied.some((row, i) => row.name !== expected[i].name || row.checksum !== expected[i].checksum)) {
        throw new DatabaseSetupError("Schema migration state differs from this checkout. Run db:migrate or restore applied migrations.");
      }
      await pool.query("SELECT id, username, display_name, status_message, created_at, updated_at FROM users LIMIT 0");
      await pool.query("SELECT id, kind, created_by FROM chat_rooms LIMIT 0");
      await pool.query("SELECT room_id, user_id, left_at FROM room_members LIMIT 0");
      await pool.query("SELECT id, room_id, sender_id, content, client_id, created_at FROM messages LIMIT 0");
      await pool.query("SELECT id, user_id, created_at, expires_at, revoked_at FROM user_sessions LIMIT 0");
      console.log("Database connection, migration checksums and application/session tables verified.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const operation = ["migrate", "seed", "check"].includes(process.argv[2]) ? process.argv[2] : "unknown";
  logFailure(console, "database.command.failed", databaseFailureCode(error), { operation });
  process.exitCode = 1;
});
