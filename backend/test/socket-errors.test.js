const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");
const { createChatServer } = require("../server");

async function fixture(t, mode = "success", sentinel = "DIRECT_ROOM_NOT_FOUND") {
  const key = randomBytes(32).toString("hex");
  const sender = randomUUID();
  const recipient = randomUUID();
  const privateValue = randomBytes(32).toString("hex");
  const row = { id: randomUUID(), room_id: randomUUID(), sender_id: sender,
    content: "Persisted message", created_at: new Date() };
  const state = { commands: [], committed: false };
  const logs = [];
  const pool = { async connect() {
    if (mode === "internal") throw Object.assign(new Error(privateValue), {
      status: 403, code: "ROOM_FORBIDDEN", detail: privateValue,
    });
    if (mode === "sentinel") throw new Error(sentinel);
    return {
      async query(sql) {
        state.commands.push(sql);
        if (sql === "COMMIT") state.committed = true;
        if (sql.includes("FROM chat_rooms")) return ["missing", "group-missing"].includes(mode)
          ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: row.room_id }] };
        if (sql.includes("FROM room_members") && mode.startsWith("group-")) {
          return mode === "group-forbidden" ? { rowCount: 0, rows: [] }
            : { rowCount: 1, rows: [{ user_id: sender }] };
        }
        if (sql.includes("FROM room_members")) return { rowCount: 2, rows: [
          { user_id: sender, left_at: mode === "inactive" ? new Date() : null },
          { user_id: recipient, left_at: null },
        ] };
        if (sql.includes("INSERT INTO messages")) return { rows: mode.endsWith("conflict") ? [] : [row] };
        if (sql.includes("FROM messages")) return { rows: [{ ...row, content: "Original content" }] };
        return { rows: [] };
      },
      release() {},
    };
  } };
  const chat = createChatServer({ pool, jwtSecret: key,
    logger: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  t.after(() => chat.close());
  const { port } = await chat.listen();
  async function connect(auth) {
    return new Promise((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, { auth, reconnection: false, timeout: 3000 });
      t.after(() => socket.disconnect());
      const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Socket test timed out")); }, 4000);
      socket.once("connect", () => { clearTimeout(timer); resolve({ socket }); });
      socket.once("connect_error", (error) => { clearTimeout(timer); socket.disconnect(); resolve({ error }); });
    });
  }
  const token = jwt.sign({ sub: sender }, key, { expiresIn: "2m" });
  return { key, sender, recipient, token, connect, row, state, logs, privateValue };
}

function acknowledge(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const callback = (error, response) => error ? reject(new Error("Socket acknowledgement timed out")) : resolve(response);
    if (payload === undefined) socket.timeout(3000).emit(event, callback);
    else socket.timeout(3000).emit(event, payload, callback);
  });
}

function failure(response, code) {
  assert.equal(response.ok, false);
  assert.equal(response.code, code);
  assert.equal(typeof response.error, "string");
  assert.equal(response.error, response.message);
  assert.deepEqual(Object.keys(response).sort(), ["code", "error", "message", "ok"]);
}

test("connect_error retains safe text and carries required, invalid and verified-expired codes", async (t) => {
  const f = await fixture(t);
  const cases = [
    [{}, "AUTH_REQUIRED", "Authentication required"],
    [{ token: "invalid" }, "AUTH_INVALID", "Invalid or expired token"],
    [{ token: jwt.sign({ sub: f.sender }, f.key, { expiresIn: -1 }) }, "AUTH_EXPIRED", "Invalid or expired token"],
    [{ token: jwt.sign({ sub: f.sender }, randomBytes(32).toString("hex"), { expiresIn: -1 }) }, "AUTH_INVALID", "Invalid or expired token"],
    [{ token: jwt.sign({}, f.key) }, "AUTH_INVALID", "Invalid token payload"],
  ];
  for (const [auth, code, message] of cases) {
    const result = await f.connect(auth);
    assert.ok(result.error, "Expected connection rejection");
    const output = JSON.stringify([result.error.data, result.error.message, f.logs]);
    assert.ok(!output.includes(f.key), "Signing key exposed (withheld)");
    if (auth.token) assert.ok(!output.includes(auth.token), "Token exposed (withheld)");
    assert.equal(result.error.message, message);
    assert.deepEqual(result.error.data, { code, message });
  }
  const valid = await f.connect({ token: f.token });
  assert.ok(valid.socket);
  assert.deepEqual(await acknowledge(valid.socket, "protected:ping"),
    { status: "success", message: "pong", userId: f.sender });
});

test("CHATAPP-27 rejections have INVALID_MESSAGE, preserve explanations and never enter persistence", async (t) => {
  const f = await fixture(t);
  const { socket } = await f.connect({ token: f.token });
  const valid = { to: f.recipient, text: f.privateValue, clientId: randomUUID() };
  for (const payload of [null, [], { ...valid, senderId: f.sender }, { ...valid, roomId: f.row.room_id },
    { ...valid, timestamp: Date.now() }, { ...valid, to: "invalid" }, { ...valid, to: f.sender.toUpperCase() },
    { ...valid, text: " " }, { ...valid, text: "x".repeat(1001) }, { ...valid, clientId: "" }]) {
    const response = await acknowledge(socket, "sendMessage", payload);
    assert.ok(!JSON.stringify([response, f.logs]).includes(f.privateValue), "Message content exposed (withheld)");
    failure(response, "INVALID_MESSAGE");
  }
  assert.deepEqual(f.state.commands, []);
});

for (const [mode, code] of [
  ["missing", "CONVERSATION_NOT_FOUND"], ["inactive", "ROOM_FORBIDDEN"], ["conflict", "CLIENT_ID_CONFLICT"],
  ["group-missing", "GROUP_ROOM_NOT_FOUND"], ["group-forbidden", "ROOM_ACCESS_DENIED"], ["group-conflict", "CLIENT_ID_CONFLICT"],
]) {
  test(`message processing returns ${code} and rolls back`, async (t) => {
    const f = await fixture(t, mode);
    const { socket } = await f.connect({ token: f.token });
    const response = await acknowledge(socket, "sendMessage", {
      ...(mode.startsWith("group-") ? { roomId: f.row.room_id } : { to: f.recipient }),
      text: f.privateValue, clientId: randomUUID(),
    });
    assert.ok(!JSON.stringify([response, f.logs]).includes(f.privateValue), "Message content exposed (withheld)");
    failure(response, code);
    assert.equal(f.state.committed, false);
    assert.equal(f.state.commands.at(-1), "ROLLBACK");
  });
}

for (const mode of ["internal", "sentinel"]) {
  test(`unknown ${mode} exceptions cannot impersonate business errors`, async (t) => {
    const f = await fixture(t, mode);
    const { socket } = await f.connect({ token: f.token });
    const response = await acknowledge(socket, "sendMessage", {
      to: f.recipient, text: f.privateValue, clientId: randomUUID(),
    });
    const output = JSON.stringify([response, f.logs]);
    assert.ok([f.privateValue, f.token, f.key].every((value) => !output.includes(value)), "Private failure details exposed (withheld)");
    failure(response, "INTERNAL_ERROR");
    assert.equal(response.message, "Message could not be saved. Please try again.");
    assert.equal(f.logs.some((args) => args[0] === "[messages] Failed to save message:"), true);
  });
}

for (const kind of ["direct", "group"]) {
  test(`all legacy sentinel messages remain untrusted for ${kind} requests`, async (t) => {
    for (const sentinel of ["DIRECT_ROOM_NOT_FOUND", "ACTIVE_MEMBERSHIP_REQUIRED", "GROUP_ROOM_NOT_FOUND", "ROOM_ACCESS_DENIED", "CLIENT_ID_REUSED"]) {
      const f = await fixture(t, "sentinel", sentinel);
      const { socket } = await f.connect({ token: f.token });
      const response = await acknowledge(socket, "sendMessage", {
        ...(kind === "group" ? { roomId: f.row.room_id } : { to: f.recipient }),
        text: f.privateValue, clientId: randomUUID(),
      });
      const output = JSON.stringify([response, f.logs]);
      assert.ok([f.privateValue, f.token, f.key, sentinel].every((value) => !output.includes(value)),
        "Untrusted failure details exposed (withheld)");
      failure(response, "INTERNAL_ERROR");
      assert.equal(response.message, "Message could not be saved. Please try again.");
      assert.deepEqual(f.state.commands, []);
    }
  });
}

test("success ACK and recipient event retain the persisted message shape after commit", async (t) => {
  const f = await fixture(t);
  const { socket: sender } = await f.connect({ token: f.token });
  const recipientToken = jwt.sign({ sub: f.recipient }, f.key, { expiresIn: "2m" });
  const { socket: recipient } = await f.connect({ token: recipientToken });
  const incoming = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Recipient event timed out")), 3000);
    recipient.once("newMessage", (message) => { clearTimeout(timer); resolve(message); });
  });
  const response = await acknowledge(sender, "sendMessage", {
    to: f.recipient, text: f.row.content, clientId: randomUUID(),
  });
  assert.equal(f.state.committed, true);
  const message = { id: f.row.id, roomId: f.row.room_id, userId: f.sender,
    to: f.recipient, text: f.row.content, timestamp: f.row.created_at.toISOString() };
  assert.deepEqual(response, { ok: true, message });
  assert.deepEqual(await incoming, message);
});
