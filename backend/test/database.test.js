const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");
const argon2 = require("argon2");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { databaseConfig, DatabaseSetupError, formatDatabaseError, testDatabaseEnvironment } = require("../db/config");
const { createPool, withTransaction } = require("../db/pool");
const { migrate, readMigrations } = require("../db/migrate");
const { seed, USERS, DIRECT_ROOM, GROUP_ROOM } = require("../db/seed");

test("real PostgreSQL integration (separate local *_test database required)", { timeout: 60000 }, async (t) => {
  let env;
  try {
    env = testDatabaseEnvironment(process.env);
  } catch (error) {
    throw new Error(`${formatDatabaseError(error)} See backend/README.md for test database setup.`);
  }
  const admin = createPool(env);
  const schema = `chatapp_test_${randomUUID().replaceAll("-", "")}`;
  // This identifier is generated here, never derived from environment/user input.
  assert.match(schema, /^chatapp_test_[a-f0-9]{32}$/);
  let pool;
  let schemaCreated = false;
  t.after(async () => {
    if (pool) await pool.end();
    try {
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  try {
    const { rows: [target] } = await admin.query("SELECT current_database() AS name");
    if (target.name !== env.PGDATABASE) throw new DatabaseSetupError("Actual test database does not match TEST_PGDATABASE.");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}` });
    pool.on("error", () => {}); // Assertions below report failures without pg error detail.
  } catch (error) {
    throw new Error(`${formatDatabaseError(error)} Start local PostgreSQL and create TEST_PGDATABASE before retrying.`);
  }
  const fixtures = { ...env, DB_ALLOW_SEED: "true" };
  const rejectCode = (promise, code) => assert.rejects(promise, (error) => {
    const codes = Array.isArray(code) ? code : [code];
    assert.ok(codes.includes(error.code), `Expected SQLSTATE ${codes.join("/")}; received ${error.code}`);
    return true;
  });

  await t.test("connects to the dedicated test database and isolated schema", async () => {
    const { rows: [row] } = await pool.query("SELECT 1 AS connected, current_schema() AS schema");
    assert.equal(row.connected, 1);
    assert.equal(row.schema, schema);
  });

  await t.test("creates the schema once, including concurrent migration runs", async () => {
    const results = await Promise.all([migrate(pool), migrate(pool)]);
    assert.equal(results.flat().length, 1);
    assert.deepEqual(await migrate(pool), []);
    const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename");
    assert.deepEqual(rows.map((row) => row.tablename), ["chat_rooms", "messages", "room_members", "schema_migrations", "users"]);
  });

  await t.test("detects applied migration changes and rolls back failed DDL", async () => {
    const files = await readMigrations();
    await assert.rejects(migrate(pool, [{ ...files[0], checksum: "changed" }]), DatabaseSetupError);
    await rejectCode(migrate(pool, [...files, {
      name: "002_rollback_probe.sql", checksum: "0".repeat(64),
      sql: "CREATE TABLE rollback_probe (id INTEGER); SELECT 1 / 0;",
    }]), "22012");
    const { rows: [row] } = await pool.query("SELECT to_regclass('rollback_probe') AS probe, (SELECT count(*)::int FROM schema_migrations) AS applied");
    assert.equal(row.probe, null);
    assert.equal(row.applied, 1);
  });

  await t.test("seeds repeatably, preserving hashes and unrelated data", async () => {
    await seed(pool, fixtures);
    const { rows: before } = await pool.query("SELECT id, password_hash FROM users ORDER BY id");
    assert.equal(before.length, 3);
    assert.equal(new Set(before.map((row) => row.password_hash)).size, 3);
    assert.ok(before.every((row) => row.password_hash.startsWith("$argon2id$") &&
      !argon2.needsRehash(row.password_hash, { memoryCost: 19456, timeCost: 2, parallelism: 1 })));
    const extra = randomUUID();
    await pool.query("INSERT INTO users (id, username, password_hash, display_name) SELECT $1, $2, password_hash, $3 FROM users WHERE id = $4",
      [extra, "unrelated_user", "Unrelated user", USERS[0][0]]);
    const reruns = await Promise.all([seed(pool, fixtures), seed(pool, fixtures)]);
    assert.ok(reruns.every((result) => result.insertedUsers === 0));
    const { rows: after } = await pool.query("SELECT id, password_hash FROM users WHERE id = ANY($1::uuid[]) ORDER BY id", [USERS.map(([id]) => id)]);
    assert.ok(before.every((row, i) => row.id === after[i].id && row.password_hash === after[i].password_hash));
    const { rows: [counts] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM chat_rooms) AS rooms,
      (SELECT count(*)::int FROM room_members) AS members,
      (SELECT count(*)::int FROM messages) AS messages`);
    assert.deepEqual(counts, { users: 4, rooms: 2, members: 5, messages: 4 });
  });

  await t.test("rejects primary-key, username and invalid user data conflicts", async () => {
    const insert = "INSERT INTO users (id, username, password_hash, display_name) SELECT $1, $2, password_hash, $3 FROM users WHERE id = $4";
    await rejectCode(pool.query(insert, [USERS[0][0], "other_name", "Other", USERS[0][0]]), "23505");
    await rejectCode(pool.query(insert, [randomUUID(), "ALICE", "Other", USERS[0][0]]), "23505");
    for (const username of ["", " white space ", "x".repeat(65)]) {
      await rejectCode(pool.query(insert, [randomUUID(), username, "Other", USERS[0][0]]), "23514");
    }
    await rejectCode(pool.query("INSERT INTO users (username, password_hash, display_name) VALUES ($1, NULL, $2)", ["null_hash", "Other"]), "23502");
  });

  await t.test("supports case-insensitive lookup and parameterized substring search without exposing hashes", async () => {
    const { rows: exact } = await pool.query('SELECT id, username FROM users WHERE lower(username COLLATE "C") = lower($1 COLLATE "C")', ["ALICE"]);
    assert.equal(exact[0].id, USERS[0][0]);
    const { rows: matches } = await pool.query("SELECT id, username FROM users WHERE username ILIKE $1 ORDER BY username LIMIT 20", ["%ali%"]);
    assert.deepEqual(matches.map((row) => row.username), ["alice"]);
    const { rowCount } = await pool.query("SELECT id FROM users WHERE username = $1", ["' OR TRUE --"]);
    assert.equal(rowCount, 0);
    assert.equal(Object.hasOwn(exact[0], "password_hash"), false);
  });

  await t.test("enforces room metadata, unique direct pairs, and foreign keys", async () => {
    await rejectCode(pool.query("INSERT INTO chat_rooms (kind, name, created_by) VALUES ('group', $1, $2)", ["Unknown creator", randomUUID()]), "23503");
    await rejectCode(pool.query("INSERT INTO chat_rooms (kind, name, created_by) VALUES ('group', $1, $2)", ["   ", USERS[0][0]]), "23514");
    await rejectCode(pool.query("INSERT INTO chat_rooms (kind, created_by, direct_user_low, direct_user_high) VALUES ('direct', $1, $1, $2)", [USERS[1][0], USERS[0][0]]), "23514");
    await rejectCode(pool.query("INSERT INTO chat_rooms (kind, created_by, direct_user_low, direct_user_high) VALUES ('direct', $1, $1, $2)", [USERS[0][0], USERS[1][0]]), "23505");
    await rejectCode(pool.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)", [randomUUID(), USERS[0][0]]), "23503");
    await rejectCode(pool.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)", [GROUP_ROOM, randomUUID()]), "23503");
    await rejectCode(pool.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)", [GROUP_ROOM, USERS[0][0]]), "23505");
    const { rows } = await pool.query("SELECT u.username FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = $1 ORDER BY u.username", [GROUP_ROOM]);
    assert.deepEqual(rows.map((row) => row.username), ["alice", "bob", "charlie"]);
  });

  await t.test("stores a member message with a database timestamp and retrieves ordered history", async () => {
    const before = Date.now();
    const { rows: [saved] } = await pool.query("INSERT INTO messages (room_id, sender_id, content, client_id) VALUES ($1, $2, $3, $4) RETURNING id, content, created_at",
      [DIRECT_ROOM, USERS[0][0], "Persistence test", randomUUID()]);
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.content, "Persistence test");
    assert.ok(saved.created_at instanceof Date);
    assert.ok(saved.created_at.getTime() >= before - 5000 && saved.created_at.getTime() <= Date.now() + 5000);
    const { rows } = await pool.query("SELECT id, created_at FROM messages WHERE room_id = $1 ORDER BY created_at, id", [DIRECT_ROOM]);
    assert.equal(rows.length, 3);
    assert.ok(rows.some((row) => row.id === saved.id));
    assert.ok(rows.every((row, i) => i === 0 || row.created_at >= rows[i - 1].created_at));
  });

  await t.test("rejects nonmember senders, missing references and blank messages", async () => {
    const insert = "INSERT INTO messages (room_id, sender_id, content, client_id) VALUES ($1, $2, $3, $4)";
    await rejectCode(pool.query(insert, [DIRECT_ROOM, USERS[2][0], "Not a member", randomUUID()]), "23503");
    await rejectCode(pool.query(insert, [GROUP_ROOM, randomUUID(), "Unknown sender", randomUUID()]), "23503");
    await rejectCode(pool.query(insert, [randomUUID(), USERS[0][0], "Unknown room", randomUUID()]), "23503");
    for (const content of ["", " \n\t"]) {
      await rejectCode(pool.query(insert, [GROUP_ROOM, USERS[0][0], content, randomUUID()]), "23514");
    }
    await rejectCode(pool.query(insert, [GROUP_ROOM, USERS[0][0], "No retry ID", ""]), "23514");
  });

  await t.test("deduplicates concurrent retries by sender/clientId, across all rooms", async () => {
    const key = randomUUID();
    const insert = `INSERT INTO messages (room_id, sender_id, content, client_id) VALUES ($1, $2, $3, $4)
      ON CONFLICT (sender_id, client_id) DO NOTHING RETURNING id`;
    const values = [GROUP_ROOM, USERS[0][0], "One persisted retry", key];
    const results = await Promise.all([pool.query(insert, values), pool.query(insert, values)]);
    assert.equal(results.reduce((sum, result) => sum + result.rowCount, 0), 1);
    const { rows } = await pool.query("SELECT id, content FROM messages WHERE sender_id = $1 AND client_id = $2", [USERS[0][0], key]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, values[2]);
    await rejectCode(pool.query("INSERT INTO messages (room_id, sender_id, content, client_id) VALUES ($1, $2, $3, $4)",
      [DIRECT_ROOM, USERS[0][0], "Conflicting retry", key]), "23505");
    // A different sender can use the same client-generated ID.
    assert.equal((await pool.query(insert, [GROUP_ROOM, USERS[1][0], "Different sender", key])).rowCount, 1);
  });

  await t.test("updates profile timestamps and retains membership/history references", async () => {
    const { rows: [before] } = await pool.query("SELECT created_at FROM users WHERE id = $1", [USERS[0][0]]);
    const { rows: [after] } = await pool.query("UPDATE users SET status_message = $1, updated_at = '1970-01-01' WHERE id = $2 RETURNING created_at, updated_at, status_message", ["Testing", USERS[0][0]]);
    assert.equal(after.status_message, "Testing");
    assert.equal(after.created_at.getTime(), before.created_at.getTime());
    assert.ok(after.updated_at.getTime() > new Date("1970-01-01").getTime());
    await rejectCode(pool.query("DELETE FROM users WHERE id = $1", [USERS[0][0]]), ["23503", "23001"]);
    await rejectCode(pool.query("DELETE FROM room_members WHERE room_id = $1 AND user_id = $2", [DIRECT_ROOM, USERS[0][0]]), ["23503", "23001"]);
    await pool.query("UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2", [DIRECT_ROOM, USERS[0][0]]);
    await assert.rejects(seed(pool, fixtures), DatabaseSetupError);
    const { rows: [member] } = await pool.query("SELECT left_at FROM room_members WHERE room_id = $1 AND user_id = $2", [DIRECT_ROOM, USERS[0][0]]);
    assert.ok(member.left_at instanceof Date);
  });

  await t.test("rolls back multi-statement failures and preserves data across a new connection", async () => {
    const roomId = randomUUID();
    await rejectCode(withTransaction(pool, async (client) => {
      await client.query("INSERT INTO chat_rooms (id, kind, name, created_by) VALUES ($1, 'group', $2, $3)", [roomId, "Rollback probe", USERS[0][0]]);
      await client.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)", [roomId, randomUUID()]);
    }), "23503");
    assert.equal((await pool.query("SELECT id FROM chat_rooms WHERE id = $1", [roomId])).rowCount, 0);
    const fresh = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}` });
    try {
      assert.equal((await fresh.query("SELECT count(*)::int AS count FROM messages WHERE room_id = $1", [DIRECT_ROOM])).rows[0].count, 3);
    } finally {
      await fresh.end();
    }
  });

  await t.test("seed identity conflicts fail without overwriting users or profiles", async () => {
    await pool.query("UPDATE users SET username = $1 WHERE id = $2", ["alice_changed", USERS[0][0]]);
    await assert.rejects(seed(pool, fixtures), DatabaseSetupError);
    const { rows: [user] } = await pool.query("SELECT username, status_message FROM users WHERE id = $1", [USERS[0][0]]);
    assert.deepEqual(user, { username: "alice_changed", status_message: "Testing" });
  });
});
