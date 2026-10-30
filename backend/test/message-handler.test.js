
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
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
const { seed, USERS, DIRECT_ROOM, GROUP_ROOM } = require("../db/seed");
const { createChatServer } = require("../server");
const { prepareTokens } = require("./helpers/session-fixtures");
const { migrate } = require("../db/migrate");

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
    let charlie;

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

      // Test tokens use an ephemeral key, independent of deployment credentials.
      const jwtSecret = randomBytes(32).toString("hex");
      const tokenFor = await prepareTokens(pool, USERS.map(([id]) => id), jwtSecret);

      chat = createChatServer({
        pool,
        jwtSecret,
        logger: { log() {}, error: console.error },
      });

      const address = await chat.listen(0);
      const url = `http://127.0.0.1:${address.port}`;

      alice = await connect(
        tokenFor(USERS[0][0]),
        url,
      );

      bob = await connect(
        tokenFor(USERS[1][0]),
        url,
      );

      charlie = await connect(
        tokenFor(USERS[2][0]),
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

      await t.test(
        "acknowledges invalid message payloads with an error",
        async () => {
          const response = await sendMessage(alice, {
            to: USERS[1][0],
            text: "   ",
            clientId: `invalid-${randomUUID()}`,
          });

          assert.equal(response.ok, false);
          assert.equal(response.code, "INVALID_MESSAGE");
          assert.equal(response.message, response.error);
          assert.match(response.error, /message must contain text/i);
        },
      );

      await t.test(
        "CHATAPP-22 rejects oversized messages without persisting them",
        async () => {
          const clientId = `oversized-${randomUUID()}`;
          const oversizedText = "x".repeat(1001);

          const response = await sendMessage(alice, {
            to: USERS[1][0],
            text: oversizedText,
            clientId,
          });

          assert.equal(response.ok, false);
          assert.equal(response.code, "INVALID_MESSAGE");
          assert.equal(response.message, response.error);
          assert.match(response.error, /at most 1000 characters/i);

          const result = await pool.query(
            `SELECT id FROM messages
             WHERE sender_id = $1 AND client_id = $2`,
            [USERS[0][0], clientId],
          );

          assert.equal(result.rowCount, 0);
        },
      );

      await t.test(
        "CHATAPP-22 rejects malformed payloads without persisting them",
        async () => {
          const clientId = `malformed-${randomUUID()}`;

          const response = await sendMessage(alice, {
            to: USERS[1][0],
            text: "This should not be saved",
            clientId,
            senderId: USERS[0][0],
          });

          assert.equal(response.ok, false);
          assert.equal(response.code, "INVALID_MESSAGE");
          assert.equal(response.message, response.error);

          const result = await pool.query(
            `SELECT id FROM messages
             WHERE sender_id = $1 AND client_id = $2`,
            [USERS[0][0], clientId],
          );

          assert.equal(result.rowCount, 0);
        },
      );

      await t.test("rejects a nonexistent recipient", async () => {
        const response = await sendMessage(alice, {
          to: randomUUID(),
          text: "This must not be stored",
          clientId: `invalid-${randomUUID()}`,
        });

        assert.equal(response.ok, false);
        assert.equal(response.code, "CONVERSATION_NOT_FOUND");
        assert.equal(response.message, response.error);
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
        assert.equal(conflicting.code, "CLIENT_ID_CONFLICT");
        assert.equal(conflicting.message, conflicting.error);
        assert.match(conflicting.error, /clientId/i);
      });
    await t.test(
        "CHATAPP-16 broadcasts persisted group messages to active members",
      async () => {
        const clientId = `group-${randomUUID()}`;
        const payload = {
          roomId: GROUP_ROOM,
          text: "Hello group members",
          clientId,
        };

        // Both connected recipients should receive the message.
        const bobIncoming = waitForEvent(bob, "newMessage");
        const charlieIncoming = waitForEvent(charlie, "newMessage");

        const response = await sendMessage(alice, payload);

        assert.equal(response.ok, true);
        assert.equal(response.message.roomId, GROUP_ROOM);
        assert.equal(response.message.userId, USERS[0][0]);
        assert.equal(response.message.text, payload.text);

        const expectedBroadcast = {
          id: response.message.id,
          from: USERS[0][0],
          roomId: GROUP_ROOM,
          content: payload.text,
          timestamp: response.message.timestamp,
        };

        const [bobMessage, charlieMessage] = await Promise.all([
          bobIncoming,
          charlieIncoming,
        ]);

        assert.deepEqual(bobMessage, expectedBroadcast);
        assert.deepEqual(charlieMessage, expectedBroadcast);

        // Verify the message was persisted exactly once.
        const { rows } = await pool.query(
          `SELECT id FROM messages
          WHERE sender_id = $1 AND client_id = $2`,
          [USERS[0][0], clientId],
        );

        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, response.message.id);

        // Retrying the same clientId must not broadcast again.
        let bobDuplicateCount = 0;
        let charlieDuplicateCount = 0;

        const countBob = () => {
          bobDuplicateCount += 1;
        };
        const countCharlie = () => {
          charlieDuplicateCount += 1;
        };

        bob.on("newMessage", countBob);
        charlie.on("newMessage", countCharlie);

        try {
          const retryResponse = await sendMessage(alice, payload);

          assert.equal(retryResponse.ok, true);
          assert.deepEqual(retryResponse.message, response.message);

          // Allow any unexpected duplicate event to arrive.
          await new Promise((resolve) => setTimeout(resolve, 150));

          assert.equal(bobDuplicateCount, 0);
          assert.equal(charlieDuplicateCount, 0);
        } finally {
          bob.off("newMessage", countBob);
          charlie.off("newMessage", countCharlie);
        }

        const { rows: retryRows } = await pool.query(
          `SELECT id FROM messages
           WHERE sender_id = $1 AND client_id = $2`,
          [USERS[0][0], clientId],
        );

        assert.equal(retryRows.length, 1);
      },
    );


      await t.test("inactive membership returns ROOM_FORBIDDEN without storing a message", async () => {
        await pool.query("UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2",
          [DIRECT_ROOM, USERS[1][0]]);
        const clientId = `forbidden-${randomUUID()}`;
        const response = await sendMessage(alice, {
          to: USERS[1][0], text: "Must not be persisted", clientId,
        });
        assert.equal(response.ok, false);
        assert.equal(response.code, "ROOM_FORBIDDEN");
        assert.equal(response.message, response.error);
        const result = await pool.query("SELECT id FROM messages WHERE sender_id = $1 AND client_id = $2",
          [USERS[0][0], clientId]);
        assert.equal(result.rowCount, 0);
      });
    } finally {
      if (alice) alice.disconnect();
      if (bob) bob.disconnect();
      if (charlie) charlie.disconnect();

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
