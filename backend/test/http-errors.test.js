const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { createChatServer } = require("../server");

async function fixture(t, options = {}) {
  const key = randomBytes(32).toString("hex");
  const userId = randomUUID();
  const logs = [];
  const commands = [];
  const pool = {
    async query(sql, values) {
      if (options.query) return options.query(sql, values);
      return { rows: [{ id: userId }] };
    },
    async connect() {
      return {
        async query(sql, values) {
          commands.push(sql);
          if (options.transactionQuery) return options.transactionQuery(sql, values);
          if (sql.startsWith("SELECT id FROM users")) return { rowCount: 0, rows: [] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const chat = createChatServer({ pool, jwtSecret: key,
    logger: { log() {}, error: (...args) => logs.push(args) } });
  t.after(() => chat.close());
  const { port } = await chat.listen();
  const token = jwt.sign({ sub: userId }, key, { expiresIn: "2m" });
  async function request(path, { authorization = `Bearer ${token}`, body, method = "GET", headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { ...(authorization === null ? {} : { Authorization: authorization }), ...headers },
      body, signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    assert.ok([key, token].every((value) => !text.includes(value)), "Credential in response (withheld)");
    return { response, body: JSON.parse(text) };
  }
  return { request, key, userId, token, logs, commands };
}

function failure(result, status, code) {
  assert.equal(result.response.status, status);
  assert.equal(result.body.status, "error");
  assert.equal(result.body.code, code);
  assert.equal(typeof result.body.message, "string");
  assert.deepEqual(Object.keys(result.body).sort(), ["code", "message", "status"]);
}

test("HTTP authentication has stable codes and retains Bearer and no-store headers", async (t) => {
  const f = await fixture(t);
  const cases = [
    [null, "AUTH_REQUIRED"], ["Basic invalid", "AUTH_INVALID"], ["Bearer invalid", "AUTH_INVALID"],
    [`Bearer ${jwt.sign({ sub: f.userId }, f.key, { expiresIn: -1 })}`, "AUTH_EXPIRED"],
    [`Bearer ${jwt.sign({ sub: f.userId }, randomBytes(32).toString("hex"), { expiresIn: -1 })}`, "AUTH_INVALID"],
    [`Bearer ${jwt.sign({ sub: "not-a-uuid" }, f.key)}`, "AUTH_INVALID"],
  ];
  for (const [authorization, code] of cases) {
    const result = await f.request("/api/users?q=", { authorization });
    failure(result, 401, code);
    assert.equal(result.response.headers.get("www-authenticate"), "Bearer");
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.body.message, "Authentication required.");
  }
});

test("registration/login validation and missing credentials use documented codes", async (t) => {
  const f = await fixture(t, { query: async () => ({ rows: [] }) });
  for (const path of ["/api/auth/register", "/api/auth/login"]) {
    failure(await f.request(path, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }),
      400, "INVALID_INPUT");
  }
  const result = await f.request("/api/auth/login", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "missing", password: randomBytes(20).toString("hex") }) });
  failure(result, 401, "INVALID_CREDENTIALS");
});

test("duplicate registration reports USERNAME_TAKEN without database details", async (t) => {
  const privateValue = randomBytes(32).toString("hex");
  const f = await fixture(t, { query: async () => {
    throw Object.assign(new Error(privateValue), { code: "23505", detail: privateValue });
  } });
  const result = await f.request("/api/auth/register", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      username: "duplicate", displayName: "Duplicate", password: randomBytes(20).toString("hex"),
    }) });
  assert.ok(!JSON.stringify([result.body, f.logs]).includes(privateValue), "Private database details exposed (withheld)");
  failure(result, 409, "USERNAME_TAKEN");
});

test("conversation errors preserve missing-recipient semantics and rollback", async (t) => {
  const f = await fixture(t);
  const result = await f.request(`/api/users/${randomUUID()}/conversation`, { method: "POST" });
  failure(result, 404, "RECIPIENT_NOT_FOUND");
  assert.equal(f.commands[0], "BEGIN");
  assert.equal(f.commands.at(-1), "ROLLBACK");
  assert.equal(f.commands.includes("COMMIT"), false);
  failure(await f.request("/api/users/invalid/conversation", { method: "POST" }), 400, "INVALID_INPUT");
  failure(await f.request(`/api/users/${f.userId}/conversation`, { method: "POST" }), 400, "INVALID_INPUT");
  failure(await f.request("/api/users/invalid/messages"), 400, "INVALID_INPUT");
  failure(await f.request(`/api/users/${f.userId}/messages`), 400, "INVALID_INPUT");
  failure(await f.request("/api/users?q=a&q=b"), 400, "INVALID_INPUT");
});

test("forged database status/code/message fields cannot become public errors", async (t) => {
  const privateValue = randomBytes(32).toString("hex");
  const f = await fixture(t, { transactionQuery: async (sql) => {
    if (sql.startsWith("SELECT")) throw Object.assign(new Error(privateValue), {
      status: 404, code: "RECIPIENT_NOT_FOUND", detail: privateValue,
    });
    return { rows: [] };
  } });
  const result = await f.request(`/api/users/${randomUUID()}/conversation`, { method: "POST" });
  assert.ok(!JSON.stringify([result.body, f.logs]).includes(privateValue), "Private exception exposed (withheld)");
  failure(result, 500, "INTERNAL_ERROR");
});

test("HTTP parsing and unknown routes have standardized safe failures", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["{", {}, 400, "INVALID_JSON"],
    [JSON.stringify({ padding: "x".repeat(110 * 1024) }), {}, 413, "PAYLOAD_TOO_LARGE"],
    ["{}", { "Content-Encoding": "unsupported" }, 415, "UNSUPPORTED_ENCODING"],
  ];
  for (const [body, headers, status, code] of cases) {
    failure(await f.request("/api/auth/login", { method: "POST", body,
      headers: { "Content-Type": "application/json", ...headers } }), status, code);
  }
  failure(await f.request("/not-an-api"), 404, "NOT_FOUND");
});

test("successful ping, empty search and empty history retain their original shapes", async (t) => {
  const f = await fixture(t, { query: async (sql) => ({ rows: sql.includes("SELECT id FROM users")
    ? [{ id: randomUUID() }] : [] }) });
  assert.deepEqual((await f.request("/api/ping")).body,
    { status: "success", message: "pong", service: "chat-backend" });
  assert.deepEqual((await f.request("/api/users?q=")).body, { users: [] });
  assert.deepEqual((await f.request(`/api/users/${randomUUID()}/messages`)).body, { messages: [] });
});
