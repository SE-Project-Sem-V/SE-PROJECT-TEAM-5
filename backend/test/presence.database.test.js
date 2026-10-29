
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const { Pool } = require("pg");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const {
  databaseConfig,
  testDatabaseEnvironment,
} = require("../db/config");
const { createPool } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { seed, USERS } = require("../db/seed");
const { createChatServer } = require("../server");

function createSocket(token, url) {
  return createClient(url, {
    auth: { token },
    autoConnect: false,
    reconnection: false,
    timeout: 3000,
  });
}

function connectSocket(socket) {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    function cleanup() {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    }

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.connect();
  });
}

function waitForPresence(socket, userId, online, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${userId} online=${online}`
        )
      );
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      socket.off("presenceUpdate", handler);
    }

    function handler(update) {
      if (update.userId === userId && update.online === online) {
        cleanup();
        resolve(update);
      }
    }

    socket.on("presenceUpdate", handler);
  });
}

function waitForNoPresence(socket, userId, online, duration = 300) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      socket.off("presenceUpdate", handler);
    }

    function handler(update) {
      if (update.userId === userId && update.online === online) {
        cleanup();
        reject(
          new Error(
            `Unexpected presence event: ${userId} online=${online}`
          )
        );
      }
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, duration);

    socket.on("presenceUpdate", handler);
  });
}

test(
  "CHATAPP-18 tracks presence across authenticated Socket.IO connections",
  { timeout: 30000 },
  async () => {
    const env = testDatabaseEnvironment(process.env);
    const admin = createPool(env);
    const schema = `chatapp_presence_test_${randomUUID().replaceAll("-", "")}`;

    let pool;
    let chat;
    let schemaCreated = false;
    const sockets = [];

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;

      pool = new Pool({
        ...databaseConfig(env),
        options: `-c search_path=${schema}`,
      });

      await migrate(pool);
      await seed(pool, { ...env, DB_ALLOW_SEED: "true" });

      const jwtSecret = randomBytes(32).toString("hex");

      chat = createChatServer({
        pool,
        jwtSecret,
        logger: { log() {}, error: console.error },
      });

      const address = await chat.listen(0);
      const url = `http://127.0.0.1:${address.port}`;

      const [aliceId, bobId, charlieId] = USERS.map(([id]) => id);

      async function openUser(userId) {
        const token = jwt.sign({ sub: userId }, jwtSecret, {
          expiresIn: "2m",
        });

        const socket = createSocket(token, url);
        sockets.push(socket);
        await connectSocket(socket);
        return socket;
      }

      // Connect Alice first and observe Bob's online transition.
      const alice = await openUser(aliceId);
      const bobOnline = waitForPresence(alice, bobId, true);
      const bob = await openUser(bobId);
      await bobOnline;

      // Charlie's snapshot must include both Alice and Bob.
      const charlieSnapshot = createSocket(
        jwt.sign({ sub: charlieId }, jwtSecret, { expiresIn: "2m" }),
        url
      );
      sockets.push(charlieSnapshot);

      const aliceSnapshot = waitForPresence(charlieSnapshot, aliceId, true);
      const bobSnapshot = waitForPresence(charlieSnapshot, bobId, true);
      const charlieOnline = waitForPresence(alice, charlieId, true);

      await connectSocket(charlieSnapshot);

      await aliceSnapshot;
      await bobSnapshot;
      await charlieOnline;

      // A second connection for Charlie must not create another
      // online transition.
      const secondCharlie = createSocket(
        jwt.sign({ sub: charlieId }, jwtSecret, { expiresIn: "2m" }),
        url
      );
      sockets.push(secondCharlie);

      const noDuplicateOnline = waitForNoPresence(alice, charlieId, true);
      await connectSocket(secondCharlie);
      await noDuplicateOnline;

      // Closing Charlie's first socket must not mark him offline.
      const noEarlyOffline = waitForNoPresence(alice, charlieId, false);
      charlieSnapshot.disconnect();
      await noEarlyOffline;

      assert.equal(secondCharlie.connected, true);

      // Closing Charlie's last socket must mark him offline.
      const charlieOffline = waitForPresence(alice, charlieId, false);
      secondCharlie.disconnect();

      assert.equal((await charlieOffline).online, false);

      // Existing users should still be connected.
      assert.equal(alice.connected, true);
      assert.equal(bob.connected, true);
    } finally {
      for (const socket of sockets) {
        socket.disconnect();
      }

      if (chat) {
        await chat.close();
      }

      if (pool) {
        await pool.end();
      }

      if (schemaCreated) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }

      await admin.end();
    }
  }
);
