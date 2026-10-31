const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { createChatServer } = require("../server");
const { memorySessions } = require("./helpers/session-fixtures");

async function fixture(t) {
  const key = randomBytes(32).toString("hex");
  const privateValue = randomBytes(32).toString("hex");
  const id = randomUUID();
  const otherId = randomUUID();
  const rows = new Map([id, otherId].map((userId, index) => [userId, {
    id: userId, username: `profile_${index}`, display_name: `Profile ${index}`, status_message: null,
    password_hash: privateValue, token: privateValue, session_id: privateValue, email: privateValue,
  }]));
  const sessions = memorySessions();
  const state = { calls: [], readFailure: false, writeFailure: false };
  const logs = [];
  const pool = {
    async query(sql, values = []) {
      state.calls.push({ sql, values });
      const session = sessions.query(sql, values);
      if (session) return session;
      if (sql.startsWith("SELECT id, username")) {
        if (state.readFailure) throw new Error(privateValue);
        return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
      }
      if (sql.startsWith("UPDATE users SET")) {
        if (state.writeFailure) throw new Error(privateValue);
        const user = rows.get(values[0]);
        if (!user) return { rows: [] };
        if (values[1]) user.display_name = values[2];
        if (values[3]) user.status_message = values[4];
        return { rows: [user] };
      }
      return { rows: [] };
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  const chat = createChatServer({ pool, jwtSecret: key, logger: { error: line => logs.push(line) } });
  t.after(() => chat.close());
  const { port } = await chat.listen();
  const token = sessions.token(id, key);
  async function request(method = "GET", body, auth = token, path = "/api/users/me", raw = false) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    assert.ok([key, privateValue, token].every(value => !text.includes(value)), "Private response data (withheld)");
    return { status: response.status, body: JSON.parse(text), cache: response.headers.get("cache-control") };
  }
  return { key, privateValue, id, otherId, rows, sessions, state, logs, token, request };
}

test("profile reads return only approved public fields with no-store", async t => {
  const f = await fixture(t);
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.cache, "no-store");
  assert.deepEqual(result.body, { user: { id: f.id, username: "profile_0", display_name: "Profile 0", status_message: null } });
  const select = f.state.calls.find(call => call.sql.startsWith("SELECT id, username"));
  assert.deepEqual(select.values, [f.id]);
  assert.ok(!select.sql.includes("password_hash"));
});

test("profile patches preserve omitted fields, support clearing, and lock the owning session", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("PATCH", { displayName: "  Renamed 🐱  " })).body.user.display_name, "  Renamed 🐱  ");
  assert.equal((await f.request("PATCH", { statusMessage: "<b>Literal text</b>" })).body.user.status_message, "<b>Literal text</b>");
  assert.equal(f.rows.get(f.id).display_name, "  Renamed 🐱  ");
  for (const statusMessage of ["", null]) {
    const result = await f.request("PATCH", { statusMessage });
    assert.equal(result.status, 200);
    assert.equal(result.body.user.status_message, null);
    assert.equal(result.cache, "no-store");
  }
  const lock = f.state.calls.findIndex(call => call.sql.includes("FOR SHARE OF s"));
  const write = f.state.calls.findIndex(call => call.sql.startsWith("UPDATE users SET"));
  const commit = f.state.calls.findIndex(call => call.sql === "COMMIT");
  assert.ok(lock >= 0 && lock < write && write < commit);
  assert.equal(f.rows.get(f.otherId).display_name, "Profile 1");
});

test("profile validation rejects invalid types, empty objects, excess length, forbidden fields and malformed text", async t => {
  const f = await fixture(t);
  const bad = [null, [], "text", 3, {}, { displayName: null }, { displayName: "" }, { displayName: " \t\n " },
    { displayName: "\u0085" }, { displayName: "\t\u0085\u2003\n" }, { displayName: "\u0085".repeat(64) },
    { displayName: "x".repeat(65) }, { statusMessage: "x".repeat(281) }, { statusMessage: 5 },
    { statusMessage: {} }, { displayName: ["name"] }, { id: f.otherId }, { userId: f.otherId },
    { username: "other" }, { password: "unused" }, { password_hash: "unused" },
    { statusMessage: "ok", extra: true }, { displayName: "bad\0name" },
    { statusMessage: "bad\ud800" }, { displayName: "bad\udfff" }];
  for (const body of bad) {
    const result = await f.request("PATCH", body);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, body === null || typeof body !== "object" ? "INVALID_JSON" : "INVALID_INPUT");
  }
  assert.equal((await f.request("PATCH", '{"displayName":', f.token, "/api/users/me", true)).body.code, "INVALID_JSON");
  assert.equal(f.state.calls.some(call => call.sql === "BEGIN"), false);
  assert.equal(f.rows.get(f.id).display_name, "Profile 0");
});

test("profile limits count Unicode characters without trimming or normalizing user text", async t => {
  const f = await fixture(t);
  const body = { displayName: "🐱".repeat(64), statusMessage: "🔒".repeat(280) };
  assert.deepEqual((await f.request("PATCH", body)).body.user,
    { id: f.id, username: "profile_0", display_name: body.displayName, status_message: body.statusMessage });
  for (const patch of [{ displayName: "🐱".repeat(65) }, { statusMessage: "🔒".repeat(281) }]) {
    assert.equal((await f.request("PATCH", patch)).status, 400);
  }
  const text = "  e\u0301 <script>literal</script>\n ";
  assert.equal((await f.request("PATCH", { statusMessage: text })).body.user.status_message, text);
  const name = "\u0085" + "猫".repeat(63);
  const result = await f.request("PATCH", { displayName: name });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.display_name, name);
  assert.equal(result.body.user.status_message, text);
});

test("profile endpoints reject missing, invalid, expired and revoked sessions", async t => {
  const f = await fixture(t);
  const claims = jwt.decode(f.token);
  const expired = jwt.sign({ ...claims, iat: claims.iat - 3600, exp: Math.floor(Date.now() / 1000) - 1 }, f.key);
  for (const [auth, code] of [[null, "AUTH_REQUIRED"], ["invalid", "AUTH_INVALID"], [expired, "AUTH_EXPIRED"]]) {
    for (const method of ["GET", "PATCH"]) {
      const result = await f.request(method, method === "PATCH" ? { displayName: "Denied" } : undefined, auth);
      assert.equal(result.status, 401);
      assert.equal(result.body.code, code);
    }
  }
  f.sessions.rows.get(claims.jti).revoked_at = new Date();
  for (const method of ["GET", "PATCH"]) {
    assert.equal((await f.request(method, method === "PATCH" ? { statusMessage: "Denied" } : undefined)).body.code, "AUTH_REVOKED");
  }
  assert.equal(f.state.calls.some(call => call.sql.startsWith("UPDATE users SET")), false);
});

test("a verified second account can edit only its own profile", async t => {
  const f = await fixture(t);
  const otherToken = f.sessions.token(f.otherId, f.key);
  assert.equal((await f.request("PATCH", { displayName: "Second" }, otherToken)).body.user.id, f.otherId);
  assert.equal(f.rows.get(f.id).display_name, "Profile 0");
  assert.equal((await f.request("PATCH", { displayName: "Denied" }, f.token, `/api/users/${f.otherId}`)).status, 404);
  assert.equal(f.rows.get(f.otherId).display_name, "Second");
});

test("profile read and transaction failures remain sanitized and roll back", async t => {
  const f = await fixture(t);
  f.state.readFailure = true;
  assert.equal((await f.request()).body.code, "INTERNAL_ERROR");
  f.state.readFailure = false;
  f.state.writeFailure = true;
  const result = await f.request("PATCH", { statusMessage: "Private profile draft" });
  assert.equal(result.status, 500);
  assert.equal(result.body.message, "Internal server error.");
  assert.ok(f.state.calls.some(call => call.sql === "ROLLBACK"));
  const output = JSON.stringify(f.logs);
  assert.ok([f.key, f.token, f.privateValue, "Private profile draft"].every(value => !output.includes(value)), "Private log data (withheld)");
});
