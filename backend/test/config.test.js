const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const net = require("node:net");
const test = require("node:test");
const { databaseConfig, DatabaseSetupError, formatDatabaseError, testDatabaseEnvironment } = require("../db/config");
const { createPool } = require("../db/pool");
const { seed } = require("../db/seed");

function environment() {
  return {
    NODE_ENV: "development", PGHOST: "127.0.0.1", PGPORT: "5432",
    PGDATABASE: "chatapp_dev", PGUSER: "chatapp", PGPASSWORD: randomBytes(24).toString("hex"),
    DB_SSL_MODE: "disable", TEST_PGDATABASE: "chatapp_test",
  };
}

test("configuration requires explicit credentials and bounds pool/timeout settings", () => {
  const env = environment();
  const config = databaseConfig(env);
  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(config.ssl, false);
  for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
    assert.throws(() => databaseConfig({ ...env, [name]: "" }), DatabaseSetupError);
  }
  for (const changes of [{ PGPORT: "65536" }, { DB_POOL_MAX: "0" }, { DB_CONNECTION_TIMEOUT_MS: "NaN" }]) {
    assert.throws(() => databaseConfig({ ...env, ...changes }), DatabaseSetupError);
  }
});

test("remote and production connections require verified TLS, with no URL override", () => {
  const env = environment();
  assert.throws(() => databaseConfig({ ...env, PGHOST: "db.example.invalid" }), /TLS/);
  assert.throws(() => databaseConfig({ ...env, NODE_ENV: "production" }), /TLS/);
  assert.deepEqual(databaseConfig({ ...env, PGHOST: "db.example.invalid", DB_SSL_MODE: "verify-full" }).ssl,
    { rejectUnauthorized: true });
  assert.throws(() => databaseConfig({ ...env, DATABASE_URL: "postgresql://localhost/unused" }), /unsupported/);
  assert.throws(() => databaseConfig({ ...env, PGOPTIONS: "-c search_path=public" }), /unsupported/);
  assert.throws(() => databaseConfig({ ...env, DB_SSL_MODE: "require" }), /verify-full/);
  assert.throws(() => databaseConfig({ ...env, DB_SSL_MODE: "verify-full", DB_SSL_CA_FILE: "missing-test-ca.pem" }), /Cannot read/);
});

test("integration target must be explicitly separate, local and named as a test database", () => {
  const env = environment();
  assert.equal(testDatabaseEnvironment(env).PGDATABASE, "chatapp_test");
  for (const changes of [
    { TEST_PGDATABASE: "" }, { TEST_PGDATABASE: "chatapp_dev" },
    { PGDATABASE: "chatapp_test" }, { PGHOST: "db.example.invalid" }, { NODE_ENV: "production" },
  ]) {
    assert.throws(() => testDatabaseEnvironment({ ...env, ...changes }), DatabaseSetupError);
  }
});

test("seed safety gates refuse targets before acquiring a database connection", async () => {
  const env = { ...environment(), DB_ALLOW_SEED: "true" };
  const pool = { connect() { assert.fail("Unsafe seed must not connect"); } };
  for (const changes of [
    { DB_ALLOW_SEED: "false" }, { NODE_ENV: "production" },
    { PGHOST: "db.example.invalid" }, { PGDATABASE: "chatapp" },
  ]) {
    await assert.rejects(seed(pool, { ...env, ...changes }), DatabaseSetupError);
  }
});

test("connection failures are bounded and diagnostics exclude sensitive error details", { timeout: 5000 }, async () => {
  // An accepting TCP socket that never speaks PostgreSQL tests the real pg
  // connection timeout without touching any existing database/service.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const pool = createPool({ ...environment(), PGPORT: String(server.address().port), DB_CONNECTION_TIMEOUT_MS: "100" });
  try {
    await assert.rejects(pool.query("SELECT 1"));
    const privateDetail = randomBytes(24).toString("hex");
    for (const code of ["28P01", "23505", "UNKNOWN"]) {
      const message = formatDatabaseError({ code, message: privateDetail, detail: privateDetail });
      assert.equal(message.includes(privateDetail), false);
    }
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
