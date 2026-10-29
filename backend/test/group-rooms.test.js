
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
    const tokenFor = (userId) =>
      jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "5m" });

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
