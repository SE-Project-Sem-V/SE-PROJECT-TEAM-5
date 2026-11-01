
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { databaseConfig, testDatabaseEnvironment } = require("../db/config");
const { createPool } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { hashPassword } = require("../security/passwords");
const { createChatServer } = require("../server");
const { prepareTokens } = require("./helpers/session-fixtures");

function request(url, token, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(url),
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: data ? JSON.parse(data) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test(
  "CHATAPP-15 creates group rooms and adds permitted members",
  { timeout: 60000 },
  async (t) => {
    const env = testDatabaseEnvironment(process.env);
    const admin = createPool(env);
    const schema = `chatapp_15_test_${randomUUID().replaceAll("-", "")}`;
    let pool;
    let schemaCreated = false;
    let chat;

    const [creator, member, outsider] = Array.from(
      { length: 3 },
      () => ({
        id: randomUUID(),
        username: `group15_${randomUUID().slice(0, 8)}`,
      }),
    );

    const jwtSecret = randomBytes(32).toString("hex");
    let tokenFor;

    try {
      const { rows: [database] } = await admin.query(
        "SELECT current_database() AS name",
      );
      assert.equal(database.name, env.PGDATABASE);

      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;

      pool = new Pool({
        ...databaseConfig(env),
        options: `-c search_path=${schema}`,
      });
      pool.on("error", () => {});

      await migrate(pool);

      const passwordHash = await hashPassword(
        randomBytes(32).toString("hex"),
      );

      for (const user of [creator, member, outsider]) {
        await pool.query(
          `INSERT INTO users
             (id, username, password_hash, display_name)
           VALUES ($1::uuid, $2::varchar, $3::text, $2::varchar)`,
          [user.id, user.username, passwordHash],
        );
      }

      tokenFor = await prepareTokens(pool, [creator.id, member.id, outsider.id], jwtSecret);
      chat = createChatServer({
        pool,
        jwtSecret,
        logger: { log() {}, error() {} },
      });

      const address = await chat.listen(0);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const creatorToken = tokenFor(creator.id);
      const memberToken = tokenFor(member.id);

      let roomId;

      await t.test("registration validates PostgreSQL name constraints without 500 responses", async () => {
        const password = randomBytes(24).toString("hex");
        const before = (await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count;
        const body = { username: "registration_probe", displayName: "Valid", password };
        for (const patch of [{ username: "bad-name" }, { username: "a".repeat(65) },
          { displayName: "a".repeat(65) }, { displayName: "\u0085\t " },
          { displayName: "\ud800" }, { displayName: "a\0b" }]) {
          const result = await request(`${baseUrl}/api/auth/register`, null, "POST", { ...body, ...patch });
          assert.equal(result.status, 400);
          assert.equal(result.body.code, "INVALID_INPUT");
        }
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, before);
        const valid = await request(`${baseUrl}/api/auth/register`, null, "POST",
          { ...body, username: "a".repeat(64), displayName: "🐱".repeat(64) });
        assert.equal(valid.status, 201);
        const stored = await pool.query("SELECT display_name FROM users WHERE id = $1", [valid.body.user.id]);
        assert.equal(stored.rows[0].display_name, "🐱".repeat(64));
      });

      await t.test(
        "authenticated creator creates a group and becomes a member",
        async () => {
          const result = await request(
            `${baseUrl}/api/rooms`,
            creatorToken,
            "POST",
            {
              name: "CHATAPP-15 acceptance group",
              memberIds: [member.id],
            },
          );

          assert.equal(result.status, 201);
          assert.ok(result.body.room.id);
          assert.equal(result.body.room.name, "CHATAPP-15 acceptance group");

          const members = result.body.room.members;
          assert.equal(members.length, 2);
          assert.ok(members.some((item) => item.id === creator.id));
          assert.ok(members.some((item) => item.id === member.id));

          roomId = result.body.room.id;
        },
      );

      await t.test(
        "creator can add a permitted user to the group",
        async () => {
          const result = await request(
            `${baseUrl}/api/rooms/${roomId}/members`,
            creatorToken,
            "POST",
            { memberIds: [outsider.id] },
          );

          assert.equal(result.status, 200);
          assert.ok(
            result.body.members.some(
              (item) => item.id === outsider.id,
            ),
          );
        },
      );

      await t.test(
        "ordinary member cannot add another user",
        async () => {
          const result = await request(
            `${baseUrl}/api/rooms/${roomId}/members`,
            memberToken,
            "POST",
            { memberIds: [randomUUID()] },
          );

          assert.equal(result.status, 403);
          assert.equal(result.body.code, "ROOM_CREATOR_REQUIRED");
        },
      );

      await t.test(
        "unauthenticated requests cannot create a group",
        async () => {
          const result = await request(
            `${baseUrl}/api/rooms`,
            null,
            "POST",
            {
              name: "Unauthorized group",
              memberIds: [member.id],
            },
          );

          assert.equal(result.status, 401);
        },
      );

      await t.test("unknown group members return controlled errors and roll back both operations", async () => {
        const counts = async () => (await pool.query(
          "SELECT (SELECT count(*)::int FROM chat_rooms) AS rooms, (SELECT count(*)::int FROM room_members) AS members")).rows[0];
        const before = await counts();
        const memberIds = [member.id, randomUUID()];
        for (const [path, body] of [["/api/rooms", { name: "Must roll back", memberIds }],
          [`/api/rooms/${roomId}/members`, { memberIds }]]) {
          const result = await request(baseUrl + path, creatorToken, "POST", body);
          assert.equal(result.status, 404);
          assert.deepEqual(result.body, { status: "error", code: "MEMBER_NOT_FOUND",
            message: "One or more selected users do not exist." });
          assert.deepEqual(await counts(), before);
        }
      });
    } finally {
      if (chat) await chat.close();
      if (pool) await pool.end();

      try {
        if (schemaCreated) {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        await admin.end();
      }
    }
  },
);
