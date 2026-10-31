const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { format } = require("node:util");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { createChatServer } = require("../server");
const { memorySessions } = require("./helpers/session-fixtures");
const { logFailure } = require("../logging");
const { createSocketAuthMiddleware } = require("../sockets/socket-auth");
const { registerMessageHandlers } = require("../sockets/message-handler");
const { createPresenceTracker } = require("../sockets/presence");
const { createPool } = require("../db/pool");
const { RoomOperationError, roomOperationCode } = require("../db/rooms");
const { DatabaseSetupError, databaseFailureCode, formatDatabaseError } = require("../db/config");

const marker = () => `PRIVATE_PROBE_${randomBytes(20).toString("hex")}`;

function capture() {
  const lines = [];
  return {
    lines,
    logger: { error: (...args) => lines.push(format(...args)) },
    records: () => lines.map((line) => {
      assert.equal(line.includes("\n"), false);
      const record = JSON.parse(line);
      assert.equal(record.level, "error");
      assert.ok(Object.keys(record).every((field) =>
        ["level", "event", "code", "scope", "operation", "status"].includes(field)));
      return record;
    }),
  };
}

function assertAbsent(output, values) {
  assert.ok(values.every((value) => !output.includes(value)), "Sensitive log content was exposed (values withheld)");
}

test("helper emits only allowlisted fields and never lets logging failure change behavior", () => {
  const f = capture();
  const secret = marker();
  assert.equal(logFailure(f.logger, "message.save.failed", "INTERNAL_ERROR",
    { scope: "group", password: secret, stack: secret }), true);
  assert.deepEqual(f.records(), [{ level: "error", event: "message.save.failed",
    code: "INTERNAL_ERROR", scope: "group" }]);
  assertAbsent(f.lines.join(""), [secret]);
  assert.equal(logFailure(f.logger, secret, "INTERNAL_ERROR"), false);
  assert.equal(logFailure(f.logger, "message.save.failed", secret, { scope: "group" }), false);
  assert.equal(logFailure(f.logger, "message.save.failed", "INTERNAL_ERROR", { scope: secret }), false);
  assert.equal(logFailure(f.logger, "http.request.failed", "AUTH_REQUIRED", { status: 500 }), false);
  assert.equal(logFailure(f.logger, "group.operation.failed", "ROOM_ACCESS_DENIED", { status: 404 }), false);
  assert.equal(logFailure(f.logger, "message.save.failed", "INTERNAL_ERROR",
    { get scope() { throw new Error(secret); } }), false);
  assert.equal(logFailure({ error() { throw new Error(secret); } }, "server.fatal", "INTERNAL_ERROR"), false);
  assert.equal(f.lines.length, 1);
});

test("group operation classification rejects forged and mutated error fields", () => {
  const secret = marker();
  const trusted = new RoomOperationError("ROOM_ACCESS_DENIED");
  trusted.code = secret;
  assert.equal(roomOperationCode(trusted), "ROOM_ACCESS_DENIED");
  const forged = Object.assign(Object.create(RoomOperationError.prototype), { code: "ROOM_ACCESS_DENIED", message: secret });
  assert.equal(roomOperationCode(forged), undefined);
  assert.equal(roomOperationCode(new Error(secret)), undefined);
});

test("HTTP auth, invalid input, group denial and unexpected failures have safe records", async (t) => {
  const f = capture();
  const secret = marker();
  const key = randomBytes(32).toString("hex");
  const userId = randomUUID();
  const roomId = randomUUID();
  const memberId = randomUUID();
  let failSearch = false;
  const sessions = memorySessions();
  const pool = {
    async query(sql, values) {
      const sessionResult = sessions.query(sql, values);
      if (sessionResult) return sessionResult;
      if (sql.startsWith("SELECT id FROM users")) return { rows: [{ id: userId }] };
      if (failSearch) throw Object.assign(new Error(secret), { code: "28P01", detail: secret });
      return { rows: [] };
    },
    async connect() {
      return { async query(sql) {
        if (sql.includes("SELECT kind, created_by")) return { rows: [{ kind: "group", created_by: memberId }] };
        return { rows: [] };
      }, release() {} };
    },
  };
  const chat = createChatServer({ pool, jwtSecret: key, logger: f.logger });
  t.after(() => chat.close());
  const { port } = await chat.listen();
  const base = `http://127.0.0.1:${port}`;
  const token = sessions.token(userId, key);
  const auth = { Authorization: `Bearer ${token}` };
  const request = (url, options = {}) => fetch(base + url, { signal: AbortSignal.timeout(3000), ...options });

  assert.equal((await request("/api/users?q=x")).status, 401);
  assert.equal((await request("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: secret, password: secret }) })).status, 400);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: secret, password: secret }) })).status, 401);
  assert.equal((await request(`/api/users?q=${encodeURIComponent(secret)}&q=x`, { headers: auth })).status, 400);
  assert.equal((await request(`/api/rooms/${roomId}/members`, { method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ memberIds: [memberId] }) })).status, 403);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: `{"password":${secret}` })).status, 400);
  failSearch = true;
  assert.equal((await request("/api/users?q=x", { headers: auth })).status, 500);

  assert.deepEqual(f.records().map(({ event, code }) => [event, code]), [
    ["http.request.failed", "AUTH_REQUIRED"], ["http.request.failed", "INVALID_INPUT"],
    ["http.request.failed", "INVALID_CREDENTIALS"], ["http.request.failed", "INVALID_INPUT"],
    ["group.operation.failed", "ROOM_CREATOR_REQUIRED"], ["http.request.failed", "INVALID_JSON"],
    ["http.request.failed", "INTERNAL_ERROR"],
  ]);
  assertAbsent(f.lines.join(""), [secret, key, token, userId, roomId, memberId]);
});

test("socket auth, message rejection, persistence and post-commit broadcast are classified separately", async () => {
  const f = capture();
  const secret = marker();
  const key = randomBytes(32).toString("hex");
  const auth = createSocketAuthMiddleware({ pool: {}, jwtSecret: key, logger: f.logger });
  let connectionError;
  await auth({ handshake: { auth: {} }, data: {} }, (error) => { connectionError = error; });
  assert.equal(connectionError.data.code, "AUTH_REQUIRED");
  await auth({ handshake: { auth: { token: secret } }, data: {} }, (error) => { connectionError = error; });
  assert.equal(connectionError.data.code, "AUTH_INVALID");
  const expiredToken = jwt.sign({ sub: randomUUID() }, key, { expiresIn: -1 });
  await auth({ handshake: { auth: { token: expiredToken } }, data: {} }, (error) => { connectionError = error; });
  assert.equal(connectionError.data.code, "AUTH_EXPIRED");

  const sender = randomUUID();
  const recipient = randomUUID();
  const roomId = randomUUID();
  const row = { id: randomUUID(), room_id: roomId, sender_id: sender,
    content: secret, created_at: new Date() };
  let mode = "denied";
  let committed = false;
  const sessions = memorySessions();
  const sessionToken = sessions.token(sender, key);
  const claims = jwt.decode(sessionToken);
  const pool = {
    async query(sql, values) { return sessions.query(sql, values) || { rows: [] }; },
    async connect() {
      if (mode === "save-failed") throw Object.assign(new Error(secret), { code: "28P01", detail: secret });
      return { async query(sql, values) {
        const sessionResult = sessions.query(sql, values);
        if (sessionResult) return sessionResult;
        if (sql === "COMMIT") committed = true;
        if (sql.includes("FROM chat_rooms")) return mode === "denied"
          ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: roomId }] };
        if (sql.includes("FROM room_members")) return mode === "group-denied"
          ? { rowCount: 0, rows: [] } : { rowCount: mode.startsWith("group") ? 1 : 2,
            rows: [{ left_at: null, user_id: sender }, { left_at: null, user_id: recipient }] };
        if (sql.includes("INSERT INTO messages")) return { rows: [row] };
        return { rows: [] };
      }, release() {} };
    },
  };
  const handlers = new Map();
  const socket = { data: { user: { id: sender }, session: { id: claims.jti, userId: sender, exp: claims.exp } }, join() {}, on(name, handler) { handlers.set(name, handler); } };
  const io = { to() { return { emit() { throw new Error(secret); } }; } };
  registerMessageHandlers({ io, socket, pool, maxMessageLength: 1000, logger: f.logger });
  const send = async (payload) => {
    let response;
    await handlers.get("sendMessage")(payload, (value) => { response = value; });
    return response;
  };
  const direct = { to: recipient, text: secret, clientId: randomUUID() };
  assert.equal((await send({ ...direct, text: " " })).code, "INVALID_MESSAGE");
  assert.equal((await send(direct)).code, "CONVERSATION_NOT_FOUND");
  mode = "group-denied";
  assert.equal((await send({ roomId, text: secret, clientId: randomUUID() })).code, "ROOM_ACCESS_DENIED");
  mode = "save-failed";
  assert.equal((await send(direct)).code, "INTERNAL_ERROR");
  mode = "success";
  const success = await send(direct);
  assert.equal(success.ok, true);
  mode = "group-success";
  const groupSuccess = await send({ roomId, text: secret, clientId: randomUUID() });
  assert.equal(groupSuccess.ok, true);
  assert.equal(committed, true);
  assert.deepEqual(f.records().map(({ event, code }) => [event, code]), [
    ["auth.socket.failed", "AUTH_REQUIRED"], ["auth.socket.failed", "AUTH_INVALID"],
    ["auth.socket.failed", "AUTH_EXPIRED"], ["message.invalid", "INVALID_MESSAGE"],
    ["message.rejected", "CONVERSATION_NOT_FOUND"],
    ["message.rejected", "ROOM_ACCESS_DENIED"],
    ["message.save.failed", "INTERNAL_ERROR"],
    ["message.broadcast.failed", "INTERNAL_ERROR"],
    ["message.broadcast.failed", "INTERNAL_ERROR"],
  ]);
  assert.deepEqual(f.records().filter(({ event }) => event === "message.broadcast.failed")
    .map(({ scope }) => scope), ["direct", "group"]);
  assertAbsent(f.lines.join(""), [secret, key, expiredToken, sender, recipient, roomId]);
});

test("presence keeps transitions when broadcasts fail and logs fixed failures", () => {
  const f = capture();
  const secret = marker();
  const tracker = createPresenceTracker({ emit() { throw new Error(secret); } }, f.logger);
  assert.equal(tracker.addConnection(secret, "socket-1"), true);
  assert.equal(tracker.isOnline(secret), true);
  assert.equal(tracker.removeConnection(secret, "socket-1"), true);
  assert.equal(tracker.isOnline(secret), false);
  assert.deepEqual(f.records().map(({ event, code, operation }) => [event, code, operation]), [
    ["presence.update.failed", "PRESENCE_UPDATE_FAILED", "online"],
    ["presence.update.failed", "PRESENCE_UPDATE_FAILED", "offline"],
  ]);
  assertAbsent(f.lines.join(""), [secret]);
});

test("failed socket room join is logged without the subject and cleans up presence", () => {
  const f = capture();
  const secret = marker();
  let removed = false;
  let disconnected = false;
  const socket = { data: { user: { id: secret } }, join() { throw new Error(secret); },
    disconnect() { disconnected = true; } };
  registerMessageHandlers({ io: {}, socket, pool: {}, maxMessageLength: 1000, logger: f.logger,
    onDisconnect() { removed = true; } });
  assert.equal(removed, true);
  assert.equal(disconnected, true);
  assert.deepEqual(f.records(), [{ level: "error", event: "presence.update.failed",
    code: "PRESENCE_UPDATE_FAILED", operation: "join" }]);
  assertAbsent(f.lines.join(""), [secret]);
});

test("database diagnostics reject arbitrary messages and exception property getters", async () => {
  const f = capture();
  const secret = marker();
  assertAbsent(formatDatabaseError(new DatabaseSetupError(secret)), [secret]);
  const hostile = { get code() { throw new Error(secret); }, get message() { throw new Error(secret); } };
  assertAbsent(formatDatabaseError(hostile), [secret]);
  assert.equal(databaseFailureCode(hostile), "DB_OPERATION_FAILED");
  const pool = createPool({ NODE_ENV: "development", PGHOST: "127.0.0.1", PGPORT: "5432",
    PGDATABASE: "chatapp_test", PGUSER: "chatapp", PGPASSWORD: secret, DB_SSL_MODE: "disable" }, f.logger);
  pool.emit("error", Object.assign(new Error(secret), { code: "28P01", detail: secret }));
  await pool.end();
  assert.deepEqual(f.records(), [{ level: "error", event: "database.idle.failed", code: "DB_AUTH_FAILED" }]);
  assertAbsent(f.lines.join(""), [secret]);
});

test("a failing logger leaves HTTP failure responses intact", async (t) => {
  const secret = marker();
  const chat = createChatServer({ pool: { connect() {} }, jwtSecret: randomBytes(32).toString("hex"),
    logger: { error() { throw new Error(secret); } } });
  t.after(() => chat.close());
  const { port } = await chat.listen();
  const response = await fetch(`http://127.0.0.1:${port}/unknown`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: "error", code: "NOT_FOUND", message: "Not found." });
});

test("startup and fatal child processes log fixed JSON and never emit exception details", () => {
  const secret = marker();
  const cwd = path.join(__dirname, "..", "..");
  const env = { ...process.env, JWT_SECRET: secret.slice(0, 8) };
  for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]) delete env[name];
  const startup = spawnSync(process.execPath, [path.join(__dirname, "..", "server.js")],
    { cwd, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(startup.status, 1);
  const startText = startup.stdout + startup.stderr;
  assert.ok(startText.includes('"event":"server.start.failed","code":"CONFIG_FAILURE"'));
  assertAbsent(startText, [secret, secret.slice(0, 8)]);

  const fatalScript = `require("./backend/server").installFatalHandlers(); Promise.reject(new Error(${JSON.stringify(secret)}));`;
  const fatal = spawnSync(process.execPath, ["-e", fatalScript],
    { cwd, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(fatal.status, 1);
  const fatalText = fatal.stdout + fatal.stderr;
  assert.ok(fatalText.includes('"event":"server.fatal","code":"INTERNAL_ERROR"'));
  assertAbsent(fatalText, [secret, "Error:", "at "]);

  const command = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "db.js"), "invalid"],
    { cwd, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(command.status, 1);
  const commandText = command.stdout + command.stderr;
  assert.ok(commandText.includes('"event":"database.command.failed","code":"DB_CONFIGURATION_FAILED","operation":"unknown"'));
  assertAbsent(commandText, [secret, secret.slice(0, 8)]);
});
