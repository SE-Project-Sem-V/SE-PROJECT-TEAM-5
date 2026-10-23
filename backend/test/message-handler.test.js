
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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
const { createPool, withTransaction } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { seed, USERS, DIRECT_ROOM } = require("../db/seed");
const { createChatServer } = require("../server");

const waitForEvent = (socket, event, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);

    const listener = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };

    socket.once(event, listener);
  });

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

test(
  "CHATAPP-13 persists timestamped Socket.IO messages and deduplicates retries",
  { timeout: 30000 },
  async (t) => {
    const env = testDatabaseEnvironment(process.env);
    const admin = createPool(env);
    const schema = `chatapp_message_test_${randomUUID().replaceAll("-", "")}`;
    let pool;
    let schemaCreated = false;
    let chat;
    let alice;
    let bob;

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

      await migrate(pool);
      await seed(pool, { ...env, DB_ALLOW_SEED: "true" });

      const jwtSecret = process.env.JWT_SECRET;
      assert.ok(jwtSecret, "JWT_SECRET must be configured");

      chat = createChatServer({
        pool,
        jwtSecret,
        logger: { log() {}, error: console.error },
      });

      const address = await chat.listen(0);
      const url = `http://127.0.0.1:${address.port}`;

      alice = await connect(
        jwt.sign({ sub: USERS[0][0] }, jwtSecret, { expiresIn: "2m" }),
        url,
      );

      bob = await connect(
        jwt.sign({ sub: USERS[1][0] }, jwtSecret, { expiresIn: "2m" }),
        url,
      );

      await t.test("persists a message with a server-generated timestamp", async () => {
        const incoming = waitForEvent(bob, "newMessage");

        const response = await sendMessage(alice, {
          to: USERS[1][0],
          text: "CHATAPP-13 integration test",
          clientId: `test-${randomUUID()}`,
        });

        assert.equal(response.ok, true);
        assert.ok(response.message.id);
        assert.equal(response.message.userId, USERS[0][0]);
        assert.equal(response.message.to, USERS[1][0]);
        assert.equal(response.message.roomId, DIRECT_ROOM);
        assert.equal(response.message.text, "CHATAPP-13 integration test");
        assert.ok(Number.isFinite(Date.parse(response.message.timestamp)));

        const delivered = await incoming;
        assert.deepEqual(delivered, response.message);

        const { rows } = await pool.query(
          `SELECT id, room_id, sender_id, content, created_at
           FROM messages WHERE id = $1`,
          [response.message.id],
        );

        assert.equal(rows.length, 1);
        assert.equal(rows[0].room_id, DIRECT_ROOM);
        assert.equal(rows[0].sender_id, USERS[0][0]);
        assert.equal(rows[0].content, "CHATAPP-13 integration test");
        assert.equal(
          new Date(rows[0].created_at).toISOString(),
          response.message.timestamp,
        );
      });

      await t.test("returns the original message for a retry", async () => {
        const clientId = `retry-${randomUUID()}`;
        const payload = {
          to: USERS[1][0],
          text: "Retry should not duplicate this",
          clientId,
        };

        const firstDelivery = waitForEvent(bob, "newMessage");
        const first = await sendMessage(alice, payload);
        assert.equal(first.ok, true);
        await firstDelivery;

        // A retry is acknowledged, but should not emit a second delivery.
        const second = await sendMessage(alice, payload);
        assert.equal(second.ok, true);
        assert.deepEqual(second.message, first.message);

        const { rows: [count] } = await pool.query(
          `SELECT count(*)::int AS count
           FROM messages
           WHERE sender_id = $1 AND client_id = $2`,
          [USERS[0][0], clientId],
        );

        assert.equal(count.count, 1);
      });

      await t.test("rejects a nonexistent recipient", async () => {
        const response = await sendMessage(alice, {
          to: randomUUID(),
          text: "This must not be stored",
          clientId: `invalid-${randomUUID()}`,
        });

        assert.equal(response.ok, false);
        assert.match(response.error, /conversation/i);
      });

      await t.test("rejects a retry with different message content", async () => {
        const clientId = `conflict-${randomUUID()}`;

        const first = await sendMessage(alice, {
          to: USERS[1][0],
          text: "Original content",
          clientId,
        });

        assert.equal(first.ok, true);

        const conflicting = await sendMessage(alice, {
          to: USERS[1][0],
          text: "Different content",
          clientId,
        });

        assert.equal(conflicting.ok, false);
        assert.match(conflicting.error, /clientId/i);
      });
    } finally {
      if (alice) alice.disconnect();
      if (bob) bob.disconnect();

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
