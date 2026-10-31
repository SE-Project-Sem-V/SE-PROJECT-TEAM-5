const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");
const { Pool } = require("pg");
const { createChatServer } = require("../server");
const { createPool } = require("../db/pool");
const { databaseConfig, testDatabaseEnvironment, formatDatabaseError } = require("../db/config");
const { migrate } = require("../db/migrate");
const { insertSession } = require("../db/sessions");
const { authenticateSession, revokeSession } = require("../services/session-service");
const { saveDirectMessage } = require("../services/message-service");
const { AppError, normalizeError } = require("../errors");
const { setTimeout: delay } = require("node:timers/promises");

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function bounded(promise, message, timeout = 4000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  })]).finally(() => clearTimeout(timer));
}

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await bounded(predicate(), message, Math.max(1, deadline - Date.now()))) return;
    await delay(20);
  }
  throw new Error(message);
}

function event(socket, name, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error("Expected session event timed out")); }, timeout);
    function receive(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, receive);
  });
}

function wrapPool(pool, hook) {
  return { query: (sql, values) => pool.query(sql, values), async connect() {
    const client = await pool.connect();
    return { async query(sql, values) { return hook(sql, values, () => client.query(sql, values), client); },
      release: error => client.release(error) };
  } };
}

test("TC-AUTH-02 durable current-session logout against isolated PostgreSQL", { timeout: 60000 }, async (t) => {
  const env = testDatabaseEnvironment(process.env);
  const admin = createPool(env);
  const schema = `chatapp_logout_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^chatapp_logout_test_[a-f0-9]{32}$/);
  const key = randomBytes(32).toString("hex");
  const password = randomBytes(32).toString("base64url");
  const privateValue = randomBytes(32).toString("hex");
  const logs = [];
  const sockets = [];
  const servers = [];
  let pool;
  let created = false;
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const server of servers) await server.close();
    if (pool) await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  try {
    const { rows: [target] } = await admin.query("SELECT current_database() AS name");
    assert.equal(target.name, env.PGDATABASE);
    assert.notEqual(target.name, process.env.PGDATABASE);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}` });
    pool.on("error", () => {});
    await migrate(pool);
  } catch (error) { throw new Error(formatDatabaseError(error)); }

  async function start(db = pool) {
    const chat = createChatServer({ pool: db, jwtSecret: key,
      logger: { log() {}, error: (...args) => logs.push(args) } });
    servers.push(chat);
    const { port } = await chat.listen();
    return { chat, url: `http://127.0.0.1:${port}` };
  }
  let running = await start();
  async function request(path, token, body, target = running) {
    const response = await fetch(target.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    assert.ok(!text.includes(password) && !text.includes(key), "Credential in response (withheld)");
    return { status: response.status, body: JSON.parse(text) };
  }
  async function connect(token, target = running) {
    const socket = io(target.url, { auth: { token }, autoConnect: false, reconnection: false, timeout: 3000 });
    sockets.push(socket);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Session socket timed out")), 4000);
      socket.once("connect", () => { clearTimeout(timer); resolve({ socket }); });
      socket.once("connect_error", error => { clearTimeout(timer); socket.disconnect(); resolve({ error }); });
    });
    socket.connect();
    return result;
  }
  const login = async username => {
    const result = await request("/api/auth/login", null, { username, password });
    assert.equal(result.status, 200);
    return result.body.token;
  };
  const sessions = {};
  let alice;
  let bob;
  let a1;
  let a1other;
  let a2;
  let b;

  await t.test("real registration and login persist distinct two-hour sessions with safe user responses", async () => {
    const anonymousLogout = await request("/api/auth/logout", null, {});
    assert.equal(anonymousLogout.status, 401);
    assert.equal(anonymousLogout.body.code, "AUTH_REQUIRED");
    const first = await request("/api/auth/register", null, { username: "logout_alice", displayName: "Alice", password });
    const second = await request("/api/auth/register", null, { username: "logout_bob", displayName: "Bob", password });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    alice = first.body.user.id;
    bob = second.body.user.id;
    sessions.a1 = first.body.token;
    sessions.b = second.body.token;
    sessions.a2 = await login("logout_alice");
    const one = jwt.verify(sessions.a1, key);
    const two = jwt.verify(sessions.a2, key);
    assert.ok(one.jti !== two.jti, "Logins must create distinct identities");
    assert.equal(one.exp - one.iat, 7200);
    const { rows } = await pool.query("SELECT * FROM user_sessions WHERE user_id = $1", [alice]);
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes(sessions.a1), "Raw JWT must not be stored");
    assert.equal(Object.hasOwn(first.body.user, "password_hash"), false);
  });

  await t.test("valid sessions retain protected HTTP, group and socket functionality", async () => {
    assert.equal((await request("/api/users?q=bob", sessions.a1)).status, 200);
    assert.equal((await request(`/api/users/${bob}/conversation`, sessions.a2, {})).status, 200);
    assert.equal((await request("/api/rooms", sessions.a2, { name: "Logout test", memberIds: [bob] })).status, 201);
    a1 = (await connect(sessions.a1)).socket;
    a1other = (await connect(sessions.a1)).socket;
    a2 = (await connect(sessions.a2)).socket;
    b = (await connect(sessions.b)).socket;
    assert.ok(a1 && a1other && a2 && b);
    // The first protected ping must work immediately after the connection handshake.
    const pong = await new Promise(resolve => a2.timeout(3000).emit("protected:ping", (_error, response) => resolve(response)));
    assert.equal(pong.status, "success");
  });

  await t.test("logout invalidates all sockets of A, preserves B and keeps the user online", async () => {
    const presence = [];
    b.on("presenceUpdate", value => presence.push(value));
    const gone = [event(a1, "disconnect"), event(a1other, "disconnect")];
    const result = await request("/api/auth/logout", sessions.a1,
      { sessionId: jwt.decode(sessions.a2).jti, userId: bob });
    assert.deepEqual(result, { status: 200, body: { status: "success" } });
    await Promise.all(gone);
    assert.equal(a2.connected, true);
    assert.equal(b.connected, true);
    assert.equal(presence.some(value => value.userId === alice && !value.online), false);
    const row = (await pool.query("SELECT revoked_at FROM user_sessions WHERE id = $1", [jwt.decode(sessions.a1).jti])).rows[0];
    assert.ok(row.revoked_at instanceof Date);
    for (const path of ["/api/users?q=bob", "/api/rooms", `/api/users/${bob}/messages`]) {
      const denied = await request(path, sessions.a1);
      assert.equal(denied.status, 401);
      assert.equal(denied.body.code, "AUTH_REVOKED");
    }
    assert.equal((await request(`/api/users/${bob}/conversation`, sessions.a1, {})).status, 401);
    assert.equal((await connect(sessions.a1)).error?.data.code, "AUTH_REVOKED");
    assert.equal((await request("/api/auth/logout", sessions.a1, {})).body.code, "AUTH_REVOKED");
    assert.equal((await request("/api/users?q=bob", sessions.a2)).status, 200);
  });

  await t.test("revocation remains effective after recreating the server and session service", async () => {
    await running.chat.close();
    running = await start();
    assert.equal((await request("/api/users?q=bob", sessions.a1)).body.code, "AUTH_REVOKED");
    assert.equal((await connect(sessions.a1)).error?.data.code, "AUTH_REVOKED");
    assert.equal((await request("/api/users?q=bob", sessions.a2)).status, 200);
  });

  await t.test("expiry disconnects an established socket and rejects subsequent HTTP access", async () => {
    const id = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 2;
    await insertSession(pool, { id, userId: alice, expiresAt: new Date(exp * 1000) });
    const token = jwt.sign({ sub: alice, jti: id, exp }, key, { algorithm: "HS256" });
    const { socket } = await connect(token);
    assert.ok(socket);
    const ended = event(socket, "auth:session-ended");
    const gone = event(socket, "disconnect");
    assert.equal((await ended).code, "AUTH_EXPIRED");
    await gone;
    assert.equal((await request("/api/users?q=bob", token)).body.code, "AUTH_EXPIRED");
    assert.equal((await request("/api/users?q=alice", sessions.b)).status, 200);
  });

  await t.test("legacy, forged ownership, missing sessions and tampered JWTs fail safely", async () => {
    const jti = jwt.decode(sessions.a2).jti;
    for (const token of [jwt.sign({ sub: alice }, key, { expiresIn: "2m" }),
      jwt.sign({ sub: bob, jti }, key, { expiresIn: "2m" }),
      jwt.sign({ sub: alice, jti: randomUUID() }, key, { expiresIn: "2m" }),
      jwt.sign({ sub: alice, jti }, randomBytes(32).toString("hex"), { expiresIn: "2m" })]) {
      assert.equal((await request("/api/users?q=x", token)).body.code, "AUTH_INVALID");
      assert.equal((await connect(token)).error?.data.code, "AUTH_INVALID");
    }
  });

  await t.test("logout closes real pending handshakes over polling and WebSocket", async () => {
    for (const transport of ["polling", "websocket"]) {
      const token = await login("logout_alice");
      const id = jwt.decode(token).jti;
      const target = await start();
      const ready = deferred();
      const release = deferred();
      let pending;
      // Hold the actual namespace handshake after authentication/session tracking.
      // The client deliberately does not react to auth:session-ended: the server must close it.
      target.chat.io.use((socket, next) => {
        if (socket.data.session.id !== id) return next();
        pending = socket;
        ready.resolve();
        release.promise.then(() => next());
      });
      const independent = (await connect(sessions.a2, target)).socket;
      assert.ok(independent);
      const client = io(target.url, { auth: { token }, transports: [transport],
        autoConnect: false, reconnection: false, timeout: 3000 });
      sockets.push(client);
      client.connect();
      try {
        await bounded(ready.promise, "Pending handshake did not reach the barrier");
        assert.equal(pending.connected, false);
        assert.equal(pending.conn.readyState, "open");
        const serverClosed = event(pending.conn, "close");
        const clientClosed = event(client.io.engine, "close");
        assert.equal((await request("/api/auth/logout", token, {}, target)).status, 200);
        await Promise.all([serverClosed, clientClosed]);
        assert.equal(pending.conn.readyState, "closed");
        assert.equal(pending.data.sessionEnded, true);
        assert.equal(pending.listeners("disconnect").some(fn => fn.name === "cleanup"), false);
        assert.equal(pending.conn.listeners("close").some(fn => fn.name === "cleanup"), false);
        assert.equal(independent.connected, true);
      } finally {
        release.resolve();
        client.disconnect();
        independent.disconnect();
        await target.chat.close();
      }
      assert.equal(pending.connected, false);
      assert.equal(target.chat.io.of("/").sockets.has(pending.id), false);
    }
  });

  await t.test("a session ending at namespace connection is closed before presence or handlers are added", async () => {
    const target = await start();
    const ready = deferred();
    let ended;
    let serverClosed;
    target.chat.io.use((socket, next) => {
      ended = socket;
      serverClosed = event(socket.conn, "close");
      socket.data.sessionEnded = true;
      socket.data.sessionFailure = new AppError("AUTH_REVOKED");
      ready.resolve();
      next();
    });
    const client = io(target.url, { auth: { token: sessions.a2 }, transports: ["websocket"],
      autoConnect: false, reconnection: false, timeout: 3000 });
    sockets.push(client);
    client.connect();
    try {
      await bounded(ready.promise, "Namespace connection did not reach the barrier");
      await serverClosed;
      assert.equal(ended.connected, false);
      assert.equal(ended.conn.readyState, "closed");
      assert.equal(target.chat.io.of("/").sockets.has(ended.id), false);
      assert.equal(ended.listenerCount("sendMessage"), 0);
      assert.equal(ended.listenerCount("protected:ping"), 0);
      assert.equal(ended.listeners("disconnect").some(fn => fn.name === "cleanup"), false);
    } finally { client.disconnect(); await target.chat.close(); }
  });

  await t.test("registration and revocation database failures roll back without false success or secret logs", async () => {
    const failing = await start(wrapPool(pool, async (sql, _values, execute) => {
      if (sql.includes("INSERT INTO user_sessions") || sql.includes("UPDATE user_sessions")) {
        throw Object.assign(new Error(privateValue), { code: "28P01", detail: privateValue });
      }
      return execute();
    }));
    const registration = await request("/api/auth/register", null,
      { username: "rollback_user", displayName: "Rollback", password }, failing);
    assert.equal(registration.status, 500);
    assert.equal(registration.body.code, "INTERNAL_ERROR");
    assert.equal((await pool.query("SELECT id FROM users WHERE username = 'rollback_user'")).rowCount, 0);
    const logout = await request("/api/auth/logout", sessions.a2, {}, failing);
    assert.equal(logout.status, 500);
    assert.equal(logout.body.code, "INTERNAL_ERROR");
    assert.equal((await request("/api/users?q=bob", sessions.a2)).status, 200);
    const output = JSON.stringify([logs, registration.body, logout.body]);
    assert.ok([password, key, privateValue, ...Object.values(sessions)].every(value => !output.includes(value)),
      "Private data exposed (withheld)");
  });

  await t.test("session locks serialize concurrent revocation and message persistence in both orders", async () => {
    // Always provide two distinct transactional connections; monitoring uses the original pool.
    const racePool = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}`, max: 2 });
    racePool.on("error", () => {});
    try {
      for (const logoutFirst of [true, false]) {
        const token = await login("logout_alice");
        const session = await authenticateSession(pool, token, key);
        const locked = deferred();
        const release = deferred();
        const attempted = deferred();
        let holderPid;
        let waiterPid;
        let secondFinished = false;
        const firstPool = wrapPool(racePool, async (sql, _values, execute, client) => {
          const result = await execute();
          if (sql === "BEGIN") await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'");
          if (logoutFirst ? sql.includes("FROM user_sessions") && sql.endsWith("FOR UPDATE")
            : sql.includes("FOR SHARE OF s")) {
            holderPid = client.processID;
            locked.resolve();
            await bounded(release.promise, "Session lock gate was not released", 12000);
          }
          return result;
        });
        const secondPool = wrapPool(racePool, async (sql, _values, execute, client) => {
          if (logoutFirst ? sql.includes("FOR SHARE OF s")
            : sql.includes("FROM user_sessions") && sql.endsWith("FOR UPDATE")) {
            waiterPid = client.processID;
            attempted.resolve();
          }
          const result = await execute();
          if (sql === "BEGIN") await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'");
          return result;
        });
        const clientId = randomUUID();
        const send = db => saveDirectMessage(db, alice, bob, "Concurrent test", clientId, session);
        const settle = promise => promise.then(value => ({ value }), error => ({ code: normalizeError(error).code }));
        const first = settle(logoutFirst ? revokeSession(firstPool, session) : send(firstPool));
        let second;
        let results;
        try {
          await bounded(locked.promise, "First session lock was not acquired");
          second = settle(logoutFirst ? send(secondPool) : revokeSession(secondPool, session))
            .then(result => { secondFinished = true; return result; });
          await bounded(attempted.promise, "Competing session lock was not attempted");
          assert.notEqual(holderPid, waiterPid, "Race must use separate database connections");
          await until(async () => {
            const { rows: [row] } = await pool.query(
              `SELECT wait_event_type, $2::int = ANY(pg_blocking_pids(pid)) AS blocked_by_holder
               FROM pg_stat_activity WHERE pid = $1::int`, [waiterPid, holderPid]);
            return row?.wait_event_type === "Lock" && row.blocked_by_holder === true;
          }, "PostgreSQL did not report the competing session lock as blocked");
          assert.equal(secondFinished, false, "Competing operation cannot finish while the first session lock is held");
        } finally {
          release.resolve();
          results = await bounded(Promise.all([first, second].filter(Boolean)), "Race operations did not finish", 8000);
        }
        assert.equal(results[0].code, undefined, "First operation must succeed");
        assert.equal(results[1].code, logoutFirst ? "AUTH_REVOKED" : undefined);
        const result = await pool.query("SELECT id FROM messages WHERE sender_id = $1 AND client_id = $2", [alice, clientId]);
        assert.equal(result.rowCount, logoutFirst ? 0 : 1);
      }
    } finally { await racePool.end(); }
  });

  await t.test("real frontend Socket.IO client recovers from transient authentication failures", async t => {
    const { createReconnectManager } = await import("../../frontend/src/reconnectManager.js");
    const previousWindow = global.window;
    const browserListeners = new Map();
    global.window = {
      addEventListener(name, handler) {
        const group = browserListeners.get(name) || new Set();
        group.add(handler);
        browserListeners.set(name, group);
      },
      removeEventListener(name, handler) { browserListeners.get(name)?.delete(handler); },
    };
    t.after(() => {
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
    });
    let unavailable = false;
    const checks = new Map();
    const target = await start({
      connect: () => pool.connect(),
      async query(sql, values) {
        if (sql.includes("FROM user_sessions")) {
          checks.set(values[0], (checks.get(values[0]) || 0) + 1);
          if (unavailable) throw new Error(privateValue);
        }
        return pool.query(sql, values);
      },
    });
    const connections = [];
    function managed(token) {
      const socket = io(target.url, { auth: { token }, forceNew: true, transports: ["websocket"],
        autoConnect: false, reconnection: true, reconnectionDelay: 20, reconnectionDelayMax: 40,
        randomizationFactor: 0, timeout: 2000 });
      sockets.push(socket);
      const events = ["connect", "disconnect", "connect_error", "auth:session-ended"];
      const existing = new Map(events.map(name => [name, new Set(socket.listeners(name))]));
      const before = new Set(socket.io.listeners("reconnect_attempt"));
      const ended = [];
      const stop = createReconnectManager(socket, () => {}, code => ended.push(code));
      const owned = events.map(name => [name, socket.listeners(name).filter(fn => !existing.get(name).has(fn))]);
      const managerOwned = socket.io.listeners("reconnect_attempt").filter(fn => !before.has(fn));
      let opens = 0;
      const opened = () => { opens += 1; };
      socket.io.on("open", opened);
      const cleanup = () => {
        stop(); // The same cleanup used by frontend logout and session replacement.
        socket.disconnect();
        for (const [name, handlers] of owned) assert.ok(handlers.every(fn => !socket.listeners(name).includes(fn)));
        assert.ok(managerOwned.every(fn => !socket.io.listeners("reconnect_attempt").includes(fn)));
        socket.io.off("open", opened);
      };
      const connection = { socket, ended, cleanup, get opens() { return opens; } };
      connections.push(connection);
      return connection;
    }
    const ping = socket => new Promise((resolve, reject) => {
      socket.timeout(3000).emit("protected:ping", (error, response) => error
        ? reject(new Error("Recovered socket did not answer protected ping")) : resolve(response));
    });
    try {
      await t.test("the same inactive namespace reconnects automatically after the database recovers", async () => {
        assert.equal((await authenticateSession(pool, sessions.a2, key)).userId, alice);
        const connection = managed(sessions.a2);
        try {
          unavailable = true;
          const rejected = event(connection.socket, "connect_error");
          connection.socket.connect();
          assert.equal((await rejected).data.code, "INTERNAL_ERROR");
          assert.equal(connection.socket.active, false);
          const recovered = event(connection.socket, "connect");
          unavailable = false;
          await recovered;
          assert.equal(connection.opens, 2);
          assert.equal((await ping(connection.socket)).status, "success");
          assert.equal((await ping(connection.socket)).userId, alice);
        } finally { unavailable = false; connection.cleanup(); }
      });

      await t.test("logout and session replacement cancel pending retries and remove listeners", async () => {
        const logoutToken = await login("logout_alice");
        const oldToken = await login("logout_alice");
        const outgoing = managed(logoutToken);
        const replaced = managed(oldToken);
        let replacement;
        try {
          unavailable = true;
          const rejected = [event(outgoing.socket, "connect_error"), event(replaced.socket, "connect_error")];
          outgoing.socket.connect();
          replaced.socket.connect();
          assert.ok((await Promise.all(rejected)).every(error => error.data.code === "INTERNAL_ERROR"));
          outgoing.cleanup();
          replaced.cleanup();
          const outgoingChecks = checks.get(jwt.decode(logoutToken).jti);
          const replacedChecks = checks.get(jwt.decode(oldToken).jti);
          unavailable = false;
          assert.equal((await request("/api/auth/logout", logoutToken, {})).status, 200);
          replacement = managed(await login("logout_alice"));
          const connected = event(replacement.socket, "connect");
          replacement.socket.connect();
          await connected;
          await delay(1100); // Beyond the first explicit retry deadline.
          assert.equal(outgoing.opens, 1);
          assert.equal(replaced.opens, 1);
          assert.equal(checks.get(jwt.decode(logoutToken).jti), outgoingChecks);
          assert.equal(checks.get(jwt.decode(oldToken).jti), replacedChecks);
          assert.equal(outgoing.socket.active, false);
          assert.equal(replaced.socket.active, false);
          assert.equal((await ping(replacement.socket)).status, "success");
        } finally {
          unavailable = false;
          outgoing.cleanup(); replaced.cleanup(); replacement?.cleanup();
        }
      });

      await t.test("revoked, expired and invalid sessions never retry", async () => {
        const revoked = await login("logout_alice");
        assert.equal((await request("/api/auth/logout", revoked, {})).status, 200);
        const claims = jwt.verify(sessions.a2, key);
        const expired = jwt.sign({ ...claims, iat: claims.iat - 3600, exp: Math.floor(Date.now() / 1000) - 1 }, key);
        const invalid = jwt.sign(claims, randomBytes(32).toString("hex"));
        for (const [token, code] of [[revoked, "AUTH_REVOKED"], [expired, "AUTH_EXPIRED"], [invalid, "AUTH_INVALID"]]) {
          const connection = managed(token);
          try {
            const rejected = event(connection.socket, "connect_error");
            connection.socket.connect();
            assert.equal((await rejected).data.code, code);
            await delay(1100);
            assert.equal(connection.opens, 1);
            assert.equal(connection.socket.active, false);
            assert.deepEqual(connection.ended, [code]);
          } finally { connection.cleanup(); }
        }
      });

      await t.test("ordinary network disconnection still uses Manager reconnection", async () => {
        const connection = managed(sessions.a2);
        try {
          const connected = event(connection.socket, "connect");
          connection.socket.connect();
          await connected;
          const disconnected = event(connection.socket, "disconnect");
          const reconnected = event(connection.socket, "connect");
          connection.socket.io.engine.close();
          await disconnected;
          await reconnected;
          assert.equal(connection.opens, 2);
          assert.equal((await ping(connection.socket)).status, "success");
          assert.deepEqual(connection.ended, []);
        } finally { connection.cleanup(); }
      });
      assert.ok([...browserListeners.values()].every(group => group.size === 0));
    } finally {
      try { for (const connection of connections) connection.cleanup(); await target.chat.close(); }
      finally {
        if (previousWindow === undefined) delete global.window;
        else global.window = previousWindow;
      }
    }
  });

  await t.test("last-session logout emits offline while an independent observer remains connected", async () => {
    const observer = (await connect(sessions.b)).socket;
    const final = (await connect(sessions.a2)).socket;
    const gone = event(final, "disconnect");
    const offline = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Offline transition timed out")), 3000);
      observer.on("presenceUpdate", value => {
        if (value.userId === alice && value.online === false) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal((await request("/api/auth/logout", sessions.a2, {})).status, 200);
    await offline;
    await gone;
    assert.equal(final.connected, false);
    assert.equal(observer.connected, true);
  });
  const hashes = (await pool.query("SELECT password_hash FROM users")).rows.map(row => row.password_hash);
  const identifiers = [alice, bob, ...Object.values(sessions).map(token => jwt.decode(token).jti)];
  const output = JSON.stringify(logs);
  assert.ok([password, key, privateValue, ...Object.values(sessions), ...hashes, ...identifiers]
    .every(value => !output.includes(value)), "Sensitive values must not appear in failure logs (withheld)");
});
