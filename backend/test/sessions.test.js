const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Socket } = require("socket.io");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { issueSession, authenticateSession, assertActiveSession, revokeSession } = require("../services/session-service");
const { normalizeError } = require("../errors");
const { createSessionLifecycle } = require("../sockets/session-lifecycle");
const { memorySessions } = require("./helpers/session-fixtures");
const { saveDirectMessage, saveGroupMessage } = require("../services/message-service");

const rejectsCode = (promise, code) => assert.rejects(promise, error => normalizeError(error).code === code);

function fixture() {
  const store = memorySessions();
  const commands = [];
  const pool = {
    async query(sql, values) { commands.push(sql); return store.query(sql, values) || { rows: [] }; },
    async connect() { return { query: (sql, values) => pool.query(sql, values), release() {} }; },
  };
  return { store, pool, commands, key: randomBytes(32).toString("hex"), userId: randomUUID() };
}

function trackedSocket(session, connected = true) {
  const socket = new EventEmitter();
  socket.data = { session };
  socket.connected = connected;
  socket.conn = new EventEmitter();
  socket.conn.readyState = "open";
  socket.conn.close = () => { socket.conn.readyState = "closed"; socket.conn.emit("close"); };
  socket.client = { _disconnect() { socket.connected = false; socket.emit("disconnect"); socket.conn.close(); } };
  socket.disconnect = Socket.prototype.disconnect;
  return socket;
}

test("session issuance creates distinct persisted identities and preserves the two-hour lifetime", async () => {
  const f = fixture();
  const first = await issueSession(f.pool, f.userId, f.key);
  const second = await issueSession(f.pool, f.userId, f.key);
  const a = jwt.verify(first, f.key, { algorithms: ["HS256"] });
  const b = jwt.verify(second, f.key, { algorithms: ["HS256"] });
  assert.ok(a.jti !== b.jti && first !== second, "Session identities must be distinct");
  assert.equal(a.exp - a.iat, 7200);
  assert.equal(f.store.rows.size, 2);
  assert.equal((await authenticateSession(f.pool, first, f.key)).userId, f.userId);
  assert.ok(!JSON.stringify([...f.store.rows.values()]).includes(first), "Token must not be persisted");
});

test("legacy, invalid, tampered and wrong-algorithm tokens are rejected without session reads", async () => {
  const f = fixture();
  const valid = f.store.token(f.userId, f.key);
  const claims = jwt.decode(valid);
  assert.equal((await authenticateSession(f.pool, valid, f.key)).userId, f.userId);
  f.commands.length = 0; // Only negative cases must avoid session reads.
  const legacy = { ...claims };
  delete legacy.jti;
  const noExpiry = { ...claims };
  delete noExpiry.exp;
  const tokens = ["invalid", jwt.sign(legacy, f.key),
    jwt.sign(claims, randomBytes(32).toString("hex")),
    jwt.sign(claims, f.key, { algorithm: "HS384" }),
    jwt.sign({ ...claims, jti: "invalid" }, f.key),
    jwt.sign(noExpiry, f.key)];
  for (const token of tokens) await rejectsCode(authenticateSession(f.pool, token, f.key), "AUTH_INVALID");
  assert.deepEqual(f.commands, []);
});

test("missing records, ownership, revocation and stored expiry are enforced", async () => {
  const f = fixture();
  const token = f.store.token(f.userId, f.key);
  const claims = jwt.decode(token);
  const row = f.store.rows.get(claims.jti);
  const otherUser = randomUUID();
  const otherToken = f.store.token(otherUser, f.key);
  assert.equal((await authenticateSession(f.pool, otherToken, f.key)).userId, otherUser);
  await rejectsCode(authenticateSession(f.pool, jwt.sign({ ...claims, sub: otherUser }, f.key), f.key), "AUTH_INVALID");
  row.revoked_at = new Date();
  await rejectsCode(authenticateSession(f.pool, token, f.key), "AUTH_REVOKED");
  row.revoked_at = null;
  row.expires_at = new Date(Date.now() - 1000);
  await rejectsCode(authenticateSession(f.pool, token, f.key), "AUTH_EXPIRED");
  f.store.rows.delete(claims.jti);
  await rejectsCode(authenticateSession(f.pool, token, f.key), "AUTH_INVALID");
});

test("JWT expiry is distinguished by verified type and database failures remain internal", async () => {
  const f = fixture();
  const token = f.store.token(f.userId, f.key);
  const claims = jwt.decode(token);
  assert.equal((await authenticateSession(f.pool, token, f.key)).userId, f.userId);
  const expired = jwt.sign({ ...claims, iat: claims.iat - 3600, exp: Math.floor(Date.now() / 1000) - 1 }, f.key);
  await rejectsCode(authenticateSession(f.pool, expired, f.key), "AUTH_EXPIRED");
  const privateValue = randomBytes(32).toString("hex");
  await rejectsCode(authenticateSession({ query() { throw Object.assign(new Error(privateValue), {
    name: "TokenExpiredError", code: "AUTH_REVOKED", status: 401,
  }); } }, token, f.key), "INTERNAL_ERROR");
});

test("revocation locks and commits only the current session; replay stays revoked", async () => {
  const f = fixture();
  const first = f.store.token(f.userId, f.key);
  const second = f.store.token(f.userId, f.key);
  const session = await authenticateSession(f.pool, first, f.key);
  await revokeSession(f.pool, session);
  assert.equal(f.commands.some(sql => sql.includes("FOR UPDATE")), true);
  assert.equal(f.commands.at(-1), "COMMIT");
  await rejectsCode(authenticateSession(f.pool, first, f.key), "AUTH_REVOKED");
  assert.equal((await authenticateSession(f.pool, second, f.key)).userId, f.userId);
  await rejectsCode(revokeSession(f.pool, session), "AUTH_REVOKED");
  assert.equal(f.commands.at(-1), "ROLLBACK");
});

test("session locking uses SHARE and never trusts a missing socket session", async () => {
  const f = fixture();
  const session = await authenticateSession(f.pool, f.store.token(f.userId, f.key), f.key);
  await assertActiveSession(f.pool, session, true);
  assert.equal(f.commands.at(-1).includes("FOR SHARE OF s"), true);
  await rejectsCode(assertActiveSession(f.pool, null, true), "AUTH_INVALID");
});

test("message services bind the authenticated session owner to the persisted sender", async () => {
  const f = fixture();
  const session = await authenticateSession(f.pool, f.store.token(f.userId, f.key), f.key);
  await rejectsCode(saveDirectMessage(f.pool, randomUUID(), f.userId, "Test", randomUUID(), session), "AUTH_INVALID");
  await rejectsCode(saveGroupMessage(f.pool, randomUUID(), randomUUID(), "Test", randomUUID(), session), "AUTH_INVALID");
  assert.equal(f.commands.some(sql => sql.includes("chat_rooms")), false);
});

for (const pendingHandshake of [false, true]) test(`logout during final socket validation is safe (pending handshake: ${pendingHandshake})`, async () => {
  const f = fixture();
  const session = await authenticateSession(f.pool, f.store.token(f.userId, f.key), f.key);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const lifecycle = createSessionLifecycle({ async query(sql, values) { await gate; return f.pool.query(sql, values); } });
  const socket = trackedSocket(session, !pendingHandshake);
  if (pendingHandshake) {
    socket.disconnect(true);
    assert.equal(socket.conn.readyState, "open", "Real Socket.IO disconnect is a no-op before connection");
  }
  const pending = lifecycle.track(socket);
  try { assert.equal(lifecycle.disconnectSession(session.id), true); }
  finally { finish(); }
  assert.equal(await pending, false);
  assert.equal(socket.connected, false);
  assert.equal(socket.data.sessionEnded, true);
  assert.equal(socket.conn.readyState, "closed");
  assert.equal(socket.listenerCount("disconnect"), 0);
  assert.equal(socket.conn.listenerCount("close"), 0);
});

test("ending an already tracked pending socket clears its expiry timer and registration", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const session = await authenticateSession(f.pool, f.store.token(f.userId, f.key), f.key);
  const socket = trackedSocket(session, false);
  let endings = 0;
  socket.on("auth:session-ended", () => { endings += 1; });
  const lifecycle = createSessionLifecycle(f.pool);
  assert.equal(await lifecycle.track(socket), true);
  assert.equal(lifecycle.disconnectSession(session.id), true);
  assert.equal(socket.conn.readyState, "closed");
  t.mock.timers.tick(7200001);
  assert.equal(lifecycle.disconnectSession(session.id), true);
  assert.equal(endings, 1, "Neither a stale timer nor a retained registration may end the socket twice");
  assert.equal(socket.listenerCount("disconnect"), 0);
  assert.equal(socket.conn.listenerCount("close"), 0);
});

test("abandoned pending namespace connections are removed before validation finishes", async () => {
  const f = fixture();
  const session = await authenticateSession(f.pool, f.store.token(f.userId, f.key), f.key);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const lifecycle = createSessionLifecycle({ async query(sql, values) { await gate; return f.pool.query(sql, values); } });
  const socket = new EventEmitter();
  socket.conn = new EventEmitter();
  socket.conn.readyState = "open";
  socket.data = { session };
  socket.disconnect = () => assert.fail("An abandoned connection must not remain registered");
  const pending = lifecycle.track(socket);
  socket.conn.readyState = "closed";
  socket.conn.emit("close");
  finish();
  const replacement = new EventEmitter();
  replacement.data = { session };
  replacement.connected = true;
  let disconnected = false;
  replacement.disconnect = () => { disconnected = true; replacement.connected = false; replacement.emit("disconnect"); };
  const replacementPending = lifecycle.track(replacement);
  assert.equal(await pending, false);
  assert.equal(await replacementPending, true);
  assert.equal(lifecycle.disconnectSession(session.id), true);
  assert.equal(disconnected, true, "Cleanup of an abandoned connection must preserve replacement connections");
  assert.equal(socket.listenerCount("disconnect"), 0);
});

test("database, emission, disconnection and logging failures fail closed without exposing exceptions", async () => {
  const f = fixture();
  const session = await authenticateSession(f.pool, f.store.token(f.userId, f.key), f.key);
  const privateValue = randomBytes(32).toString("hex");
  const logger = { error() { throw new Error(privateValue); } };
  const lifecycle = createSessionLifecycle({ query() { throw new Error(privateValue); } }, logger);
  const socket = new EventEmitter();
  socket.data = { session };
  socket.connected = true;
  socket.disconnect = () => { throw new Error(privateValue); };
  const payloads = [];
  socket.on("auth:session-ended", payload => { payloads.push(payload); throw new Error(privateValue); });
  assert.equal(await lifecycle.track(socket), false);
  assert.equal(socket.data.sessionEnded, true);
  assert.equal(payloads[0].code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(payloads).includes(privateValue));
  assert.equal(lifecycle.disconnectSession(session.id), true);
  const live = createSessionLifecycle(f.pool, logger);
  const other = new EventEmitter();
  other.data = { session };
  other.connected = true;
  other.disconnect = () => { throw new Error(privateValue); };
  assert.equal(await live.track(other), true);
  assert.equal(live.disconnectSession(session.id), false, "Disconnection failures must not claim success");
  assert.equal(other.data.sessionEnded, true);
  other.emit("disconnect");
});
