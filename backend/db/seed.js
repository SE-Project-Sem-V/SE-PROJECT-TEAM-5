const { randomBytes } = require("node:crypto");
const argon2 = require("argon2");
const { DatabaseSetupError, isLocalHost } = require("./config");
const { withTransaction } = require("./pool");

const USERS = [
  ["10000000-0000-4000-8000-000000000001", "alice", "Alice (demo)"],
  ["10000000-0000-4000-8000-000000000002", "bob", "Bob (demo)"],
  ["10000000-0000-4000-8000-000000000003", "charlie", "Charlie (demo)"],
];
const DIRECT_ROOM = "20000000-0000-4000-8000-000000000001";
const GROUP_ROOM = "20000000-0000-4000-8000-000000000002";
const MESSAGES = [
  ["30000000-0000-4000-8000-000000000001", DIRECT_ROOM, USERS[0][0], "Hello Bob!", "seed-direct-1"],
  ["30000000-0000-4000-8000-000000000002", DIRECT_ROOM, USERS[1][0], "Hi Alice!", "seed-direct-2"],
  ["30000000-0000-4000-8000-000000000003", GROUP_ROOM, USERS[0][0], "Welcome to the demo room.", "seed-group-1"],
  ["30000000-0000-4000-8000-000000000004", GROUP_ROOM, USERS[2][0], "Ready to test persistence.", "seed-group-2"],
];

function seedConflict() {
  return new DatabaseSetupError("Seed fixture conflicts with existing data. Nothing was overwritten; use a separate development database.");
}

async function seed(pool, env = process.env) {
  if (!["development", "test"].includes(env.NODE_ENV) || env.DB_ALLOW_SEED !== "true" ||
      !isLocalHost(env.PGHOST || "") || !/^[a-z][a-z0-9_]*_(dev|test)$/.test(env.PGDATABASE || "")) {
    throw new DatabaseSetupError("Seeding requires DB_ALLOW_SEED=true, development/test mode, and a loopback database ending in _dev or _test.");
  }

  return withTransaction(pool, async (client) => {
    const { rows: [target] } = await client.query("SELECT current_database() AS name");
    if (target.name !== env.PGDATABASE) throw new DatabaseSetupError("Seed target does not match the configured development/test database.");
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext(current_schema() || ':chatapp-seed'))");
    let insertedUsers = 0;
    for (const [id, username, displayName] of USERS) {
      const { rows } = await client.query(
        'SELECT id, username FROM users WHERE id = $1 OR lower(username COLLATE "C") = $2', [id, username],
      );
      if (rows.length) {
        if (rows.length !== 1 || rows[0].id !== id || rows[0].username !== username) throw seedConflict();
        continue;
      }
      // No known fixture password is committed, stored, printed, or returned.
      // The random input is discarded; CHATAPP-26 owns real authentication.
      const passwordHash = await argon2.hash(randomBytes(32), {
        type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
      });
      await client.query("INSERT INTO users (id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)",
        [id, username, passwordHash, displayName]);
      insertedUsers += 1;
    }

    for (const [id, kind, name, low, high] of [
      [DIRECT_ROOM, "direct", null, USERS[0][0], USERS[1][0]],
      [GROUP_ROOM, "group", "Team 5 demo", null, null],
    ]) {
      const values = [id, kind, name, USERS[0][0], low, high];
      await client.query(`INSERT INTO chat_rooms (id, kind, name, created_by, direct_user_low, direct_user_high)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, values);
      const { rows: [room] } = await client.query("SELECT kind, name, created_by, direct_user_low, direct_user_high FROM chat_rooms WHERE id = $1", [id]);
      if (!room || [room.kind, room.name, room.created_by, room.direct_user_low, room.direct_user_high]
        .some((value, index) => value !== values[index + 1])) throw seedConflict();
    }

    for (const [roomId, members] of [[DIRECT_ROOM, USERS.slice(0, 2)], [GROUP_ROOM, USERS]]) {
      for (const [userId] of members) {
        await client.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT (room_id, user_id) DO NOTHING", [roomId, userId]);
        const { rows: [member] } = await client.query("SELECT left_at FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, userId]);
        if (member.left_at !== null) throw seedConflict();
      }
    }

    for (const values of MESSAGES) {
      await client.query(`INSERT INTO messages (id, room_id, sender_id, content, client_id)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`, values);
      const { rows: [message] } = await client.query("SELECT room_id, sender_id, content, client_id FROM messages WHERE id = $1", [values[0]]);
      if (!message || [message.room_id, message.sender_id, message.content, message.client_id]
        .some((value, index) => value !== values[index + 1])) throw seedConflict();
    }
    return { insertedUsers, fixtureUsers: USERS.length, fixtureRooms: 2, fixtureMemberships: 5, fixtureMessages: MESSAGES.length };
  });
}

module.exports = { seed, USERS, DIRECT_ROOM, GROUP_ROOM };
