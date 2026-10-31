const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { databaseConfig, testDatabaseEnvironment, formatDatabaseError } = require("../db/config");
const { createPool } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { hashPassword } = require("../security/passwords");
const { createChatServer } = require("../server"); // Loads the ignored backend/.env quietly.
const { prepareTokens } = require("./helpers/session-fixtures");

test("CHATAPP-10 authenticated user search against isolated PostgreSQL", { timeout: 60000 }, async (t) => {
  const env = testDatabaseEnvironment(process.env);
  const admin = createPool(env);
  const schema = `chatapp_search_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^chatapp_search_test_[a-f0-9]{32}$/);
  let created = false;
  let pool;
  let chat;
  t.after(async () => {
    try {
      if (chat) await chat.close();
    } finally {
      try {
        if (pool) await pool.end();
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } catch (error) {
        throw new Error(formatDatabaseError(error));
      } finally {
        await admin.end();
      }
    }
  });

  const me = randomUUID();
  const names = ["Alice", "Alina", "sALi", "bob", "bob_01", "bobX01", "slash_user", "departed",
    "x".repeat(64), "order_z", "Order_B", "order_a",
    ...Array.from({ length: 26 }, (_, i) => `member${String(25 - i).padStart(2, "0")}`)];
  const ids = names.map((_, i) => i === 0 ? me : randomUUID());
  const hash = await hashPassword(randomBytes(32).toString("hex"));
  const publicProfile = "Public display and status";
  try {
    const { rows: [target] } = await admin.query("SELECT current_database() AS name");
    assert.equal(target.name, env.PGDATABASE);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}` });
    pool.on("error", () => {});
    await migrate(pool);
    await pool.query(
      `INSERT INTO users (id, username, password_hash, display_name, status_message)
       SELECT id, username, $3, $4, $4 FROM unnest($1::uuid[], $2::text[]) AS fixture(id, username)`,
      [ids, names, hash, publicProfile],
    );
  } catch (error) {
    throw new Error(`${formatDatabaseError(error)} Check the isolated PostgreSQL test configuration.`);
  }
  const key = randomBytes(32).toString("hex");
  const logs = [];
  chat = createChatServer({ pool, jwtSecret: key, logger: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const { port } = await chat.listen();
  const tokenFor = await prepareTokens(pool, ids, key);
  const token = tokenFor(me);
  async function request(query, authorization = token, raw = false) {
    const suffix = raw ? query : `?q=${encodeURIComponent(query)}`;
    const response = await fetch(`http://127.0.0.1:${port}/api/users${suffix}`, {
      headers: authorization ? { Authorization: `Bearer ${authorization}` } : {}, signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    assert.ok([key, token, hash].every((value) => !text.includes(value)), "Private data in response (withheld)");
    return { status: response.status, body: JSON.parse(text) };
  }

  await t.test("uses the dedicated test database and a private schema", async () => {
    const { rows: [row] } = await pool.query("SELECT current_database() AS database, current_schema() AS schema");
    assert.equal(row.database, env.PGDATABASE);
    assert.notEqual(row.database, process.env.PGDATABASE);
    assert.equal(row.schema, schema);
  });

  await t.test("partial matching is case-insensitive and trims whitespace", async () => {
    const result = await request("  aLI  ");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.users.map((u) => u.username), ["Alina", "sALi"]);
  });

  await t.test("excludes the caller, including an uppercase UUID subject", async () => {
    const uppercaseToken = tokenFor(me.toUpperCase());
    assert.deepEqual(await request("Alice", uppercaseToken), { status: 200, body: { users: [] } });
    const result = await request("ali", uppercaseToken);
    assert.ok(result.body.users.every((u) => u.id !== me));
  });

  await t.test("empty, missing and unmatched queries succeed with users: []", async () => {
    for (const query of ["", "   ", "not_registered"]) {
      assert.deepEqual(await request(query), { status: 200, body: { users: [] } });
    }
    assert.deepEqual(await request("", token, true), { status: 200, body: { users: [] } });
  });

  await t.test("SQL wildcards and escape characters are searched literally", async () => {
    const underscores = await request("_");
    assert.deepEqual(underscores.body.users.map((u) => u.username),
      ["bob_01", "order_a", "Order_B", "order_z", "slash_user"]);
    assert.deepEqual((await request("bob_0")).body.users.map((u) => u.username), ["bob_01"]);
    for (const query of ["%", "!", "\\", "bob%01", "!_"]) {
      assert.deepEqual(await request(query), { status: 200, body: { users: [] } });
    }
  });

  await t.test("SQL injection cannot broaden the directory or mutate tables", async () => {
    for (const query of ["%' OR TRUE --", "Alice'; DROP TABLE users; --"]) {
      assert.deepEqual(await request(query), { status: 200, body: { users: [] } });
    }
    const { rows: [counts] } = await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM chat_rooms) AS rooms, (SELECT count(*)::int FROM room_members) AS members,
      (SELECT count(*)::int FROM messages) AS messages`);
    assert.deepEqual(counts, { users: names.length, rooms: 0, members: 0, messages: 0 });
  });

  await t.test("accepts 64 characters and rejects oversized or structured queries", async () => {
    assert.deepEqual((await request("x".repeat(64))).body.users.map((u) => u.username), ["x".repeat(64)]);
    assert.equal((await request("x".repeat(65))).status, 400);
    for (const suffix of ["?q=a&q=b", "?q[]=a", "?q[username]=a", "?q=a&limit=99", "?q=%FF"]) {
      assert.equal((await request(suffix, token, true)).status, 400);
    }
  });

  await t.test("sorts by case-insensitive username and bounds results to 20", async () => {
    assert.deepEqual((await request("order_")).body.users.map((u) => u.username), ["order_a", "Order_B", "order_z"]);
    const first = await request("member");
    const second = await request("MEMBER");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.users.map((u) => u.username), Array.from({ length: 20 }, (_, i) => `member${String(i).padStart(2, "0")}`));
    assert.deepEqual(second, first);
  });

  await t.test("requires a valid token and rechecks account existence on every request", async () => {
    const absent = jwt.sign({ sub: randomUUID() }, key, { expiresIn: "2m" });
    const expired = jwt.sign({ sub: me }, key, { expiresIn: -1 });
    for (const [auth, code] of [[null, "AUTH_REQUIRED"], [absent, "AUTH_INVALID"], [expired, "AUTH_EXPIRED"], ["invalid", "AUTH_INVALID"]]) {
      assert.deepEqual(await request("ali", auth), { status: 401, body: { status: "error", code, message: "Authentication required." } });
    }
    const departingId = ids[names.indexOf("departed")];
    const departingToken = tokenFor(departingId);
    assert.equal((await request("ali", departingToken)).status, 200);
    await pool.query("DELETE FROM users WHERE id = $1", [departingId]);
    assert.equal((await request("ali", departingToken)).status, 401);
  });

  await t.test("returns only public fields and never logs credentials or profiles", async () => {
    const logCount = logs.length;
    const result = await request("ali");
    assert.equal(result.status, 200);
    for (const user of result.body.users) {
      assert.deepEqual(Object.keys(user).sort(), ["display_name", "id", "status_message", "username"]);
      assert.equal(user.display_name, publicProfile);
      assert.equal(user.status_message, publicProfile);
    }
    const output = JSON.stringify(logs);
    assert.ok([key, token, hash, publicProfile].every((value) => !output.includes(value)), "Private data logged (withheld)");
    assert.equal(logs.length, logCount, "Successful search should not add a failure log");
    assert.ok(logs.every(([line]) => {
      const record = JSON.parse(line);
      return record.level === "error" && record.event === "http.request.failed" &&
        ["INVALID_INPUT", "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_EXPIRED"].includes(record.code);
    }));
  });
});
