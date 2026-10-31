
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
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

function connect(token, url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      auth: { token },
      reconnection: false,
      timeout: 3000,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket connection timed out"));
    }, 4000);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
}

function sendMessage(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit("sendMessage", payload, (error, response) => {
      if (error) return reject(error);
      resolve(response);
    });
  });
}

function request(url, token, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      target,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test(
  "CHATAPP-25 authorizes group operations",
  { timeout: 60000 },
  async (t) => {
    const env = testDatabaseEnvironment(process.env);
    const admin = createPool(env);
    const schema = `chatapp_authz_test_${randomUUID().replaceAll("-", "")}`;
    let pool;
    let schemaCreated = false;
    let chat;
    const sockets = [];

    const users = Array.from({ length: 3 }, () => ({
      id: randomUUID(),
      username: `authz_${randomUUID().slice(0, 8)}`,
    }));

    const [creator, member, outsider] = users;
    const jwtSecret = randomBytes(32).toString("hex");
    const tokens = new Map();

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

      const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
      for (const user of users) {
        await pool.query(
            `INSERT INTO users (id, username, password_hash, display_name)
            VALUES ($1::uuid, $2::varchar, $3::text, $2::varchar)`,
            [user.id, user.username, passwordHash],
        );
      }

      const tokenFor = await prepareTokens(pool, users.map(user => user.id), jwtSecret);
      for (const user of users) tokens.set(user.id, tokenFor(user.id));
      chat = createChatServer({
        pool,
        jwtSecret,
        logger: { log() {}, error: console.error },
      });

      const address = await chat.listen(0);
      const baseUrl = `http://127.0.0.1:${address.port}`;

      for (const user of users) {
        sockets.push(await connect(tokens.get(user.id), baseUrl));
      }

      let roomId;

      await t.test("authenticated users can create groups", async () => {
        const result = await request(
          `${baseUrl}/api/rooms`,
          tokens.get(creator.id),
          "POST",
          {
            name: "Authorization test group",
            memberIds: [member.id],
          },
        );

        assert.equal(result.status, 201);
        assert.ok(result.body.room.id);
        assert.equal(result.body.room.members.length, 2);
        roomId = result.body.room.id;
      });

      await t.test("creator identity cannot be overridden by request data", async () => {
        const result = await request(
          `${baseUrl}/api/rooms`,
          tokens.get(member.id),
          "POST",
          {
            name: "Identity test group",
            memberIds: [outsider.id],
            createdBy: creator.id,
          },
        );

        assert.equal(result.status, 400);
      });

      await t.test("only the creator can add group members", async () => {
        const denied = await request(
          `${baseUrl}/api/rooms/${roomId}/members`,
          tokens.get(member.id),
          "POST",
          { memberIds: [outsider.id] },
        );

        assert.equal(denied.status, 403);

        const creatorResult = await request(
          `${baseUrl}/api/rooms/${roomId}/members`,
          tokens.get(creator.id),
          "POST",
          { memberIds: [outsider.id] },
        );

        assert.equal(creatorResult.status, 200);
        assert.ok(
          creatorResult.body.members.some((item) => item.id === outsider.id),
        );
      });

      await t.test("active members can send group messages", async () => {
        const response = await sendMessage(sockets[1], {
          roomId,
          text: "Authorized group message",
          clientId: `group-${randomUUID()}`,
        });

        assert.equal(response.ok, true);
        assert.equal(response.message.roomId, roomId);
        assert.equal(response.message.userId, member.id);

        const { rows } = await pool.query(
          `SELECT room_id, sender_id, content
           FROM messages WHERE id = $1`,
          [response.message.id],
        );

        assert.equal(rows.length, 1);
        assert.equal(rows[0].room_id, roomId);
        assert.equal(rows[0].sender_id, member.id);
        assert.equal(rows[0].content, "Authorized group message");
      });

      await t.test("non-members cannot send group messages", async () => {
        const { rows: [secondRoom] } = await pool.query(
          `INSERT INTO chat_rooms (kind, name, created_by)
           VALUES ('group', 'Private test group', $1)
           RETURNING id`,
          [creator.id],
        );

        await pool.query(
          "INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)",
          [secondRoom.id, creator.id],
        );

        const response = await sendMessage(sockets[1], {
          roomId: secondRoom.id,
          text: "Must be denied",
          clientId: `denied-${randomUUID()}`,
        });

        assert.equal(response.ok, false);
        assert.match(response.error, /active member/i);

        const { rows } = await pool.query(
          "SELECT id FROM messages WHERE client_id = $1",
          [response.message?.clientId ?? "nonexistent"],
        );
        assert.equal(rows.length, 0);
      });

      await t.test("only active members can read group history", async () => {
        // Create a separate private group containing only the creator.
        const { rows: [privateRoom] } = await pool.query(
           `INSERT INTO chat_rooms (kind, name, created_by)
            VALUES ('group', 'Private history test', $1)
            RETURNING id`,
            [creator.id],
        );

        await pool.query(
            `INSERT INTO room_members (room_id, user_id)
            VALUES ($1, $2)`,
            [privateRoom.id, creator.id],
        );

        // A non-member must not read this group's history.
        const denied = await request(
            `${baseUrl}/api/rooms/${privateRoom.id}/messages`,
            tokens.get(outsider.id),
        );

        assert.equal(denied.status, 403);

        // A member who has left must not read the original group's history.
        await pool.query(
            `UPDATE room_members
            SET left_at = now()
            WHERE room_id = $1 AND user_id = $2`,
            [roomId, member.id],
        );

        const departed = await request(
            `${baseUrl}/api/rooms/${roomId}/messages`,
            tokens.get(member.id),
        );

        assert.equal(departed.status, 403);

        // The creator must still be able to read the original group's history.
        const allowed = await request(
            `${baseUrl}/api/rooms/${roomId}/messages`,
             tokens.get(creator.id),
        );

        assert.equal(allowed.status, 200);
        assert.ok(Array.isArray(allowed.body.messages));
        assert.ok(allowed.body.messages.length > 0);
    });

      await t.test("direct-message behavior remains available", async () => {
        const { rows: [room] } = await pool.query(
          `INSERT INTO chat_rooms (
             kind, created_by, direct_user_low, direct_user_high
           )
           VALUES (
             'direct', $1,
             LEAST($1::uuid, $2::uuid),
             GREATEST($1::uuid, $2::uuid)
           )
           RETURNING id`,
          [creator.id, member.id],
        );

        await pool.query(
          `INSERT INTO room_members (room_id, user_id)
           VALUES ($1, $2), ($1, $3)`,
          [room.id, creator.id, member.id],
        );

        const response = await sendMessage(sockets[0], {
          to: member.id,
          text: "Direct still works",
          clientId: `direct-${randomUUID()}`,
        });

        assert.equal(response.ok, true);
        assert.equal(response.message.roomId, room.id);
        assert.equal(response.message.text, "Direct still works");
      });
    } finally {
      for (const socket of sockets) socket.disconnect();
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
