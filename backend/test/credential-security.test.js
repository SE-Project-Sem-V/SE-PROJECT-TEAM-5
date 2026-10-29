const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { format } = require("node:util");
const test = require("node:test");
const argon2 = require("argon2");
const express = require("express");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const { hashPassword, verifyPassword, PasswordInputError, MAX_PASSWORD_BYTES } = require("../security/passwords");
const { validateJwtSecret, SecurityConfigurationError, JWT_SECRET_ERROR } = require("../security/config");
const { createHttpErrorHandler } = require("../middleware/error-handler");
const { createChatServer } = require("../server");

const temporarySecret = () => randomBytes(32).toString("hex");
const unusedPool = { connect() { assert.fail("This security test must not access PostgreSQL"); } };

// Capture console calls too: Express's default error handler bypasses an
// injected logger. Leave Node's test-reporting streams intact, and never include
// captured text in assertions. Startup tests separately inspect child output.
function captureOutput(t) {
  const chunks = [];
  for (const method of ["log", "error", "warn"]) {
    t.mock.method(console, method, (...args) => chunks.push(format(...args)));
  }
  return () => chunks.join("");
}

function assertAbsent(text, values) {
  assert.ok(values.every((value) => !text.includes(value)), "Sensitive data was exposed (values withheld)");
}

async function startChat(t, options = {}) {
  const key = temporarySecret();
  const chat = createChatServer({ pool: unusedPool, jwtSecret: key, ...options });
  t.after(() => chat.close());
  const address = await chat.listen(0);
  return { chat, key, url: `http://127.0.0.1:${address.port}` };
}

async function connect(t, url, auth) {
  const socket = createClient(url, { auth, reconnection: false, timeout: 2000 });
  t.after(() => socket.disconnect());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Test connection timed out."));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({ socket, accepted: true });
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve({ socket, accepted: false, message: error.message, data: error.data });
    });
  });
}

function acknowledge(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(event, ...args, (error, response) => {
      if (error) reject(new Error("Test acknowledgement timed out."));
      else resolve(response);
    });
  });
}

test("passwords use independently salted Argon2id hashes and verify correctly", async () => {
  const password = temporarySecret();
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.ok(first !== second && first !== password && second !== password);
  assert.ok(first.startsWith("$argon2id$v=19$"));
  assert.equal(argon2.needsRehash(first, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), false);
  assert.ok(await verifyPassword(password, first));
  assert.ok(await verifyPassword(password, second));
  assert.equal(await verifyPassword(temporarySecret(), first), false);
});

test("password verification preserves Unicode, spaces, and characters beyond bcrypt's byte limit", async () => {
  const password = `  ${temporarySecret()}${"\u{1f512}".repeat(20)}e\u0301  `;
  const hash = await hashPassword(password);
  assert.ok(await verifyPassword(password, hash));
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword(password.normalize("NFC"), hash), false);
  assert.equal(await verifyPassword(password.slice(0, -1) + "x", hash), false);
});

test("password inputs are bounded in UTF-8 bytes without exposing invalid input", async (t) => {
  const output = captureOutput(t);
  const password = temporarySecret();
  const tooLong = password + "\u{1f512}".repeat(MAX_PASSWORD_BYTES / 4);
  for (const value of [undefined, null, 123, {}, Buffer.from(password), "", "\ud800", tooLong]) {
    await assert.rejects(hashPassword(value), PasswordInputError);
    assert.equal(await verifyPassword(value, "$argon2id$invalid"), false);
  }
  const boundary = "\u{1f512}".repeat(MAX_PASSWORD_BYTES / 4);
  assert.ok(await verifyPassword(boundary, await hashPassword(boundary)));
  assertAbsent(output(), [password, tooLong]);
});

test("malformed, plaintext and unsupported hash formats fail closed", async (t) => {
  const output = captureOutput(t);
  const password = temporarySecret();
  for (const hash of [null, undefined, 123, {}, "", password, "$2b$12$invalid", "$argon2i$invalid",
    "$argon2id$", "$argon2id$v=19$m=invalid,t=2,p=1$invalid$invalid", "$argon2id$" + "x".repeat(513)]) {
    assert.equal(await verifyPassword(password, hash), false);
  }
  assertAbsent(output(), [password]);
});

test("hashing library failures never propagate credential-bearing errors", async (t) => {
  const output = captureOutput(t);
  const secret = temporarySecret();
  t.mock.method(argon2, "hash", async () => { throw new Error(secret); });
  t.mock.method(argon2, "verify", async () => { throw new Error(secret); });
  await assert.rejects(hashPassword(secret), (error) => {
    assert.equal(error.message, "Password hashing failed.");
    assert.equal(Object.hasOwn(error, "cause"), false);
    assertAbsent(error.stack, [secret]);
    return true;
  });
  assert.equal(await verifyPassword(secret, "$argon2id$invalid"), false);
  assertAbsent(output(), [secret]);
});

test("the shared verifier accepts hashes generated with the existing seed policy", async () => {
  const password = temporarySecret();
  const hash = await argon2.hash(Buffer.from(password), {
    type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
  });
  assert.ok(await verifyPassword(password, hash));
});

test("JWT validation rejects missing, short, whitespace and repeated-character keys", async () => {
  const key = temporarySecret();
  assert.ok(validateJwtSecret(key) === key);
  for (const value of [undefined, null, {}, Buffer.from(key), "", " ".repeat(64),
    randomBytes(15).toString("hex"), ` ${key}`, `${key}\n`, "x".repeat(64)]) {
    assert.throws(() => validateJwtSecret(value), (error) => {
      assert.ok(error instanceof SecurityConfigurationError);
      assert.equal(error.message, JWT_SECRET_ERROR);
      return true;
    });
    // An undefined factory option intentionally defaults to the environment;
    // the startup test below supplies a missing environment key explicitly.
    if (value !== undefined) {
      assert.throws(() => createChatServer({ pool: unusedPool, jwtSecret: value }), SecurityConfigurationError);
    }
  }
});

test("startup rejects bad JWT configuration before database setup without exposing it", { timeout: 15000 }, () => {
  for (const key of [undefined, " ".repeat(64), randomBytes(8).toString("hex"), "x".repeat(64)]) {
    const env = { ...process.env, NODE_ENV: "test", JWT_SECRET: key ?? "" };
    for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]) delete env[name];
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "server.js")], {
      cwd: path.join(__dirname, "..", ".."), env, encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes('"event":"server.start.failed","code":"CONFIG_FAILURE"'));
    assert.equal(output.includes("PGHOST must be set"), false);
    if (key?.trim()) assertAbsent(output, [key]);
  }
});

for (const mode of ["development", "production"]) {
  test(`malformed JSON never exposes credentials in ${mode} responses or output`, { timeout: 5000 }, async (t) => {
    const output = captureOutput(t);
    const { chat, key, url } = await startChat(t);
    chat.app.set("env", mode);
    const password = `PW_PROBE_${temporarySecret()}`;
    const token = `TOKEN_PROBE_${temporarySecret()}`;
    const body = `{"password":${password},"token":"${token}"}`;
    const response = await fetch(`${url}/api/auth/login?secret=${token}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Cookie: `session=${token}` },
      body, signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { status: "error", code: "INVALID_JSON", message: "Invalid JSON request." });
    await new Promise(setImmediate);
    assertAbsent(output() + text, ["PW_PROBE_", "TOKEN_PROBE_", password, token, key, body]);
    assert.ok(output().includes('"event":"http.request.failed","code":"INVALID_JSON","status":400'));
  });
}

test("oversized bodies and unsupported encodings receive controlled errors", { timeout: 5000 }, async (t) => {
  const output = captureOutput(t);
  const { url } = await startChat(t);
  const secret = temporarySecret();
  const cases = [
    { body: JSON.stringify({ password: secret, padding: "x".repeat(110 * 1024) }), headers: {}, status: 413 },
    { body: JSON.stringify({ password: secret }), headers: { "Content-Encoding": secret }, status: 415 },
    { body: JSON.stringify({ password: secret }), headers: { "Content-Type": `application/json; charset=${secret}` }, status: 415 },
  ];
  for (const item of cases) {
    const response = await fetch(`${url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", ...item.headers },
      body: item.body, signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, item.status);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, item.status === 413 ? "PAYLOAD_TOO_LARGE" : "UNSUPPORTED_ENCODING");
    await new Promise(setImmediate);
    assertAbsent(text + output(), [secret, secret.toUpperCase(), item.body]);
  }
});

test("ping remains available and unknown routes do not echo credential-bearing URLs", async (t) => {
  const output = captureOutput(t);
  const { url } = await startChat(t);
  const ping = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(2000) });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { status: "success", message: "pong", service: "chat-backend" });
  const secret = temporarySecret();
  const response = await fetch(`${url}/${secret}?token=${secret}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { status: "error", code: "NOT_FOUND", message: "Not found." });
  assertAbsent(body + output(), [secret]);
});

test("unexpected HTTP errors conceal messages, stacks, bodies and headers", async (t) => {
  const output = captureOutput(t);
  const secret = temporarySecret();
  const app = express();
  app.set("env", "development");
  app.get("/failure", (_req, _res, next) => next(Object.assign(new Error(secret), {
    type: secret, status: 401, body: secret, headers: { Authorization: secret },
  })));
  app.use(createHttpErrorHandler());
  const server = http.createServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/failure`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { status: "error", code: "INTERNAL_ERROR", message: "Internal server error." });
  await new Promise(setImmediate);
  assertAbsent(body + output() + JSON.stringify([...response.headers]), [secret]);
});

test("errors after headers close the response without forwarding the raw error", () => {
  const secret = temporarySecret();
  const entries = [];
  let destroyed = false;
  createHttpErrorHandler({ error: (...args) => entries.push(args) })(new Error(secret), {}, {
    headersSent: true, destroy() { destroyed = true; },
  }, () => assert.fail("Raw errors must not reach Express's default logger"));
  assert.ok(destroyed);
  assertAbsent(JSON.stringify(entries), [secret]);
});

test("JWT WebSocket authentication and protected acknowledgements remain intact without token logs", { timeout: 15000 }, async (t) => {
  const output = captureOutput(t);
  const { key, url } = await startChat(t);
  const userId = randomUUID();
  const token = jwt.sign({ sub: userId }, key, { expiresIn: "2m" });
  const valid = await connect(t, url, { token });
  assert.ok(valid.accepted);
  assert.deepEqual(await acknowledge(valid.socket, "protected:ping"), { status: "success", message: "pong", userId });
  const badTokens = [temporarySecret(), jwt.sign({ sub: userId }, key, { expiresIn: -1 }),
    jwt.sign({ sub: userId }, temporarySecret(), { expiresIn: "2m" }), jwt.sign({}, key, { expiresIn: "2m" })];
  const missing = await connect(t, url, {});
  assert.equal(missing.accepted, false);
  assert.equal(missing.message, "Authentication required");
  assert.equal(missing.data.code, "AUTH_REQUIRED");
  for (const [index, badToken] of badTokens.entries()) {
    const result = await connect(t, url, { token: badToken });
    assert.equal(result.accepted, false);
    assert.ok(["Invalid or expired token", "Invalid token payload"].includes(result.message));
    assert.equal(result.data.code, index === 1 ? "AUTH_EXPIRED" : "AUTH_INVALID");
    assert.equal(result.data.message, result.message);
    assertAbsent(result.message + JSON.stringify(result.data), [badToken, key]);
  }
  valid.socket.disconnect();
  await new Promise(setImmediate);
  assertAbsent(output(), [key, token, ...badTokens]);
});

test("message database failures retain safe acknowledgements and redact private error details", { timeout: 5000 }, async (t) => {
  const output = captureOutput(t);
  const secret = temporarySecret();
  const pool = { async connect() { throw Object.assign(new Error(secret), { code: "28P01", detail: secret }); } };
  const { key, url } = await startChat(t, { pool });
  const token = jwt.sign({ sub: randomUUID() }, key, { expiresIn: "2m" });
  const connection = await connect(t, url, { token });
  assert.ok(connection.accepted);
  const response = await acknowledge(connection.socket, "sendMessage", {
    to: randomUUID(), text: secret, clientId: randomUUID(),
  });
  assert.deepEqual(response, { ok: false, code: "INTERNAL_ERROR",
    message: "Message could not be saved. Please try again.", error: "Message could not be saved. Please try again." });
  assertAbsent(output() + JSON.stringify(response), [secret, key, token]);
  assert.ok(output().includes('"event":"message.save.failed","code":"INTERNAL_ERROR","scope":"direct"'));
});
