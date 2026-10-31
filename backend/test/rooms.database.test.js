const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { databaseConfig, testDatabaseEnvironment, formatDatabaseError } = require("../db/config");
const { createPool } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { hashPassword } = require("../security/passwords");
const { RoomOperationError, createGroupRoom, addGroupMembers, isActiveMember, listRoomMembers } = require("../db/rooms");

test("CHATAPP-50 room operations against isolated PostgreSQL", { timeout: 60000 }, async (t) => {
  const env = testDatabaseEnvironment(process.env);
  const admin = createPool(env);
  const schema = `chatapp_rooms_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^chatapp_rooms_test_[a-f0-9]{32}$/);
  let pool;
  let created = false;
  t.after(async () => {
    try {
      if (pool) await pool.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) {
      throw new Error(formatDatabaseError(error));
    } finally {
      await admin.end();
    }
  });

  const [bob, zelda, alice, alina] = Array.from({ length: 4 }, () => randomUUID());
  try {
    const { rows: [target] } = await admin.query("SELECT current_database() AS name");
    assert.equal(target.name, env.PGDATABASE);
    assert.notEqual(target.name, process.env.PGDATABASE);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}` });
    pool.on("error", () => {});
    await migrate(pool);
    const hash = await hashPassword(randomBytes(32).toString("hex"));
    await pool.query(
      `INSERT INTO users (id, username, password_hash, display_name)
       SELECT id, username, $3, username FROM unnest($1::uuid[], $2::text[]) AS fixture(id, username)`,
      [[bob, zelda, alice, alina], ["bob", "Zelda", "alice", "Alina"], hash],
    );
  } catch (error) {
    throw new Error(`${formatDatabaseError(error)} Check the isolated PostgreSQL test configuration.`);
  }

  const rejectCode = (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error.code, code, "Unexpected operation/SQLSTATE code (details withheld)");
    return true;
  });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM chat_rooms) AS rooms,
    (SELECT count(*)::int FROM room_members) AS members`)).rows[0];
  const group = (memberIds = [], name = "Test group") => createGroupRoom(pool, { name, createdBy: bob, memberIds });

  await t.test("uses the dedicated database, private schema and committed migrations", async () => {
    const { rows: [target] } = await pool.query("SELECT current_database() AS name, current_schema() AS schema");
    assert.equal(target.name, env.PGDATABASE);
    assert.equal(target.schema, schema);
    assert.deepEqual((await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows,
      [{ name: "001_initial_schema.sql" }, { name: "002_sessions.sql" }]);
  });

  await t.test("creates a group atomically with active creator and selected members", async () => {
    const room = await group([zelda, alice]);
    assert.equal(room.kind, "group");
    assert.equal(room.name, "Test group");
    assert.equal(room.created_by, bob);
    assert.ok(room.created_at instanceof Date);
    assert.deepEqual(room.members.map((m) => m.id), [alice, bob, zelda]);
    assert.ok(room.members.every((m) => m.joined_at instanceof Date && m.left_at === null));
    assert.equal(await isActiveMember(pool, room.id, bob), true);
    const { rows: [stored] } = await pool.query("SELECT direct_user_low, direct_user_high FROM chat_rooms WHERE id = $1", [room.id]);
    assert.deepEqual(stored, { direct_user_low: null, direct_user_high: null });
  });

  await t.test("includes the creator once and deduplicates UUIDs regardless of casing", async () => {
    const room = await group([bob, bob.toUpperCase(), alice, alice.toUpperCase(), alice]);
    assert.deepEqual(room.members.map((m) => m.id), [alice, bob]);
    assert.deepEqual((await group()).members.map((m) => m.id), [bob]);
  });

  await t.test("adds existing users and keeps repeated and concurrent additions idempotent", async () => {
    const room = await group();
    const before = await listRoomMembers(pool, room.id);
    await Promise.all([
      addGroupMembers(pool, room.id, [alice, alice.toUpperCase(), zelda], bob),
      addGroupMembers(pool, room.id, [zelda, alice], bob),
    ]);
    const members = await listRoomMembers(pool, room.id);
    assert.deepEqual(members.map((m) => m.id), [alice, bob, zelda]);
    assert.deepEqual(members.find((m) => m.id === bob), before[0]);
    assert.deepEqual(await addGroupMembers(pool, room.id, [alice, bob, zelda], bob), members);
    assert.deepEqual(await addGroupMembers(pool, room.id, [], bob), members);
  });

  await t.test("only the group creator can add members", async () => {
    const room = await group();
    const before = await listRoomMembers(pool, room.id);

    await assert.rejects(
      addGroupMembers(pool, room.id, [alice], zelda),
      (error) =>
        error instanceof RoomOperationError &&
        error.code === "ROOM_CREATOR_REQUIRED",
    );

    assert.deepEqual(await listRoomMembers(pool, room.id), before);

    await addGroupMembers(pool, room.id, [alice], bob);
    assert.equal(await isActiveMember(pool, room.id, alice), true);
  });

  await t.test("rejects unknown creators and rolls back group creation on an invalid member", async () => {
    const before = await counts();
    await rejectCode(createGroupRoom(pool, { name: "Unknown creator", createdBy: randomUUID() }), "23503");
    await rejectCode(group([alice, randomUUID()]), "23503");
    await rejectCode(group([alice, "not-a-uuid"]), "22P02");
    assert.deepEqual(await counts(), before);
    assert.equal((await pool.query("SELECT 1 AS usable")).rows[0].usable, 1);
  });

  await t.test("rejects invalid references and rolls back a batch without partial additions", async () => {
    const room = await group();
    const before = await counts();
    await rejectCode(addGroupMembers(pool, randomUUID(), [alice], bob), "ROOM_NOT_FOUND");
    await rejectCode(addGroupMembers(pool, room.id, [alice, randomUUID()], bob), "23503");
    await rejectCode(addGroupMembers(pool, room.id, [alice, "not-a-uuid"], bob), "22P02");
    assert.deepEqual(await counts(), before);
    assert.deepEqual((await listRoomMembers(pool, room.id)).map((m) => m.id), [bob]);
  });

  await t.test("lets existing constraints validate names without creating orphan rooms", async () => {
    const before = await counts();
    for (const name of ["", " \t\n"]) await rejectCode(group([], name), "23514");
    await rejectCode(group([], "x".repeat(101)), "22001");
    assert.deepEqual(await counts(), before);
    assert.equal((await group([], "x".repeat(100))).name.length, 100);
  });

  await t.test("binds SQL-like group names as data", async () => {
    const name = "Team'); DROP TABLE room_members; --";
    const room = await group([alice], name);
    assert.equal(room.name, name);
    assert.equal((await listRoomMembers(pool, room.id)).length, 2);
  });

  await t.test("checks active, absent and departed membership without modifying it", async () => {
    const room = await group([alice]);
    assert.equal(await isActiveMember(pool, room.id, alice), true);
    assert.equal(await isActiveMember(pool, room.id, zelda), false);
    assert.equal(await isActiveMember(pool, randomUUID(), alice), false);
    assert.equal(await isActiveMember(pool, room.id, randomUUID()), false);
    await pool.query("UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2", [room.id, alice]);
    assert.equal(await isActiveMember(pool, room.id, alice), false);
    assert.equal(await isActiveMember(pool, room.id, bob), true);
  });

  await t.test("rejects departed members rather than reactivating or partly adding a batch", async () => {
    const room = await group([alice]);
    await pool.query("UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2", [room.id, alice]);
    const before = await listRoomMembers(pool, room.id, { includeDeparted: true });
    await assert.rejects(addGroupMembers(pool, room.id, [zelda, alice.toUpperCase()], bob),
      (error) => error instanceof RoomOperationError && error.code === "MEMBER_REJOIN_REQUIRED");
    assert.deepEqual(await listRoomMembers(pool, room.id, { includeDeparted: true }), before);
    assert.equal(await isActiveMember(pool, room.id, zelda), false);
    assert.equal(await isActiveMember(pool, room.id, alice), false);
  });

  await t.test("lists public member fields in deterministic order, with departed users opt-in", async () => {
    const room = await group([zelda, alina, alice]);
    // All membership timestamps are tied by the creation transaction.
    assert.equal(new Set(room.members.map((m) => m.joined_at.toISOString())).size, 1);
    assert.deepEqual(room.members.map((m) => m.username), ["alice", "Alina", "bob", "Zelda"]);
    assert.deepEqual(await listRoomMembers(pool, room.id), room.members);
    for (const member of room.members) {
      assert.deepEqual(Object.keys(member).sort(), ["id", "joined_at", "left_at", "username"]);
    }
    await pool.query("UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2", [room.id, alina]);
    assert.deepEqual((await listRoomMembers(pool, room.id)).map((m) => m.id), [alice, bob, zelda]);
    const all = await listRoomMembers(pool, room.id, { includeDeparted: true });
    assert.deepEqual(all.map((m) => m.id), [alice, alina, bob, zelda]);
    assert.ok(all.find((m) => m.id === alina).left_at instanceof Date);
    assert.deepEqual(await listRoomMembers(pool, randomUUID()), []);
  });

  await t.test("rejects all direct-room additions, including a third participant and departed pair", async () => {
    const { rows: [room] } = await pool.query(
      `INSERT INTO chat_rooms (kind, created_by, direct_user_low, direct_user_high)
       VALUES ('direct', $1, LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)) RETURNING id`,
      [bob, alice],
    );
    await pool.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)", [room.id, bob, alice]);
    await pool.query("UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2", [room.id, alice]);
    const before = await listRoomMembers(pool, room.id, { includeDeparted: true });
    for (const ids of [[zelda], [bob], [alice], []]) {
      await rejectCode(addGroupMembers(pool, room.id, ids, bob), "GROUP_ROOM_REQUIRED");
    }
    assert.deepEqual(await listRoomMembers(pool, room.id, { includeDeparted: true }), before);
    assert.equal(await isActiveMember(pool, room.id, bob), true);
    assert.equal(await isActiveMember(pool, room.id, alice), false);
    assert.equal(await isActiveMember(pool, room.id, zelda), false);
  });

  await t.test("rejects malformed collection inputs without writing database records", async () => {
    const before = await counts();
    for (const memberIds of [null, alice, [null], [42]]) {
      await assert.rejects(group(memberIds), TypeError);
      await assert.rejects(addGroupMembers(pool, randomUUID(), memberIds, bob), TypeError);
    }
    await assert.rejects(createGroupRoom(pool, { name: null, createdBy: bob }), TypeError);
    await assert.rejects(createGroupRoom(pool, { name: "Group", createdBy: null }), TypeError);
    await assert.rejects(listRoomMembers(pool, randomUUID(), { includeDeparted: "false" }), TypeError);
    assert.deepEqual(await counts(), before);
  });
});
