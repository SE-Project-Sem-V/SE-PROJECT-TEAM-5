const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createChatServer } = require("../server");

function createMockPool() {
  const users = [];

  return {
    users,

    async connect() {
      return {
        query: async () => ({ rows: [] }),
        release: () => {},
      };
    },

    async query(sql, params = []) {
      if (sql.includes("INSERT INTO users")) {
        const [id, username, passwordHash, displayName] = params;

        if (users.some((user) => user.username === username)) {
          const error = new Error("Duplicate username");
          error.code = "23505";
          throw error;
        }

        const user = {
          id,
          username,
          password_hash: passwordHash,
          display_name: displayName,
        };

        users.push(user);

        return {
          rows: [{
            id: user.id,
            username: user.username,
            display_name: user.display_name,
          }],
        };
      }

      if (sql.includes("SELECT id, username, display_name, password_hash")) {
        const username = params[0].toLowerCase();

        const user = users.find(
          (item) => item.username.toLowerCase() === username,
        );

        return { rows: user ? [user] : [] };
      }

      throw new Error("Unexpected database query in authentication test.");
    },

    end: async () => {},
  };
}

async function startTestServer(t) {
  const pool = createMockPool();
  const jwtSecret = randomBytes(32).toString("hex");

  const chat = createChatServer({
    pool,
    jwtSecret,
    logger: { error: () => {} },
  });

  const address = await new Promise((resolve, reject) => {
    chat.server.once("error", reject);
    chat.server.listen(0, "127.0.0.1", () => {
      chat.server.removeListener("error", reject);
      resolve(chat.server.address());
    });
  });

  t.after(async () => {
    await chat.close();
  });

  return {
    pool,
    jwtSecret,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("registration creates a user and returns success", async (t) => {
  const { pool, baseUrl, jwtSecret } = await startTestServer(t);

  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "anand_test",
      password: "TestPassword123!",
      displayName: "Anand Test",
    }),
  });

  assert.equal(response.status, 201);

  const body = await response.json();

  assert.equal(body.status, "success");
  assert.equal(typeof body.token, "string");

  const payload = jwt.verify(body.token, jwtSecret);
  assert.equal(payload.sub, body.user.id);

  assert.equal(body.user.username, "anand_test");
  assert.equal(body.user.display_name, "Anand Test");
  assert.equal(pool.users.length, 1);
  assert.notEqual(pool.users[0].password_hash, "TestPassword123!");
  assert.match(pool.users[0].password_hash, /^\$argon2id\$/);
});

test("login with valid credentials returns a verifiable JWT", async (t) => {
  const { baseUrl, jwtSecret } = await startTestServer(t);

  await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "login_test",
      password: "TestPassword123!",
      displayName: "Login Test",
    }),
  });

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "login_test",
      password: "TestPassword123!",
    }),
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.status, "success");
  assert.equal(body.user.username, "login_test");
  assert.equal(typeof body.token, "string");

  const payload = jwt.verify(body.token, jwtSecret);

  assert.equal(payload.sub, body.user.id);
});

test("login rejects an incorrect password", async (t) => {
  const { baseUrl } = await startTestServer(t);

  await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "wrong_password_test",
      password: "CorrectPassword123!",
      displayName: "Wrong Password Test",
    }),
  });

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "wrong_password_test",
      password: "IncorrectPassword123!",
    }),
  });

  assert.equal(response.status, 401);

  const body = await response.json();

  assert.equal(body.status, "error");
  assert.equal(body.message, "Invalid username or password.");
});

test("login rejects a nonexistent username", async (t) => {
  const { baseUrl } = await startTestServer(t);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "not_registered",
      password: "SomePassword123!",
    }),
  });

  assert.equal(response.status, 401);
});
