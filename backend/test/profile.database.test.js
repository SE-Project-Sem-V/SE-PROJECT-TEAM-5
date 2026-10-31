const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");
const { databaseConfig, testDatabaseEnvironment, formatDatabaseError } = require("../db/config");
const { createPool } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { createChatServer } = require("../server");

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, message, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

test("CHATAPP-9 profiles persist and respect revoked sessions in isolated PostgreSQL", { timeout: 60000 }, async t => {
  const env = testDatabaseEnvironment(process.env);
  const admin = createPool(env);
  const schema = `chatapp_profile_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^chatapp_profile_test_[a-f0-9]{32}$/);
  const key = randomBytes(32).toString("hex");
  const password = randomBytes(32).toString("hex");
  const logs = [];
  const servers = [];
  let pool;
  let created = false;
  t.after(async () => {
    try { for (const chat of servers) await chat.close(); }
    finally {
      try { if (pool) await pool.end(); }
      finally {
        try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    }
  });
  try {
    const { rows: [target] } = await admin.query("SELECT current_database() AS name");
    assert.equal(target.name, env.PGDATABASE);
    assert.notEqual(target.name, process.env.PGDATABASE);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ ...databaseConfig(env), options: `-c search_path=${schema}`, max: 6 });
    pool.on("error", () => {});
    await migrate(pool);
  } catch (error) { throw new Error(formatDatabaseError(error)); }

  async function start(db = pool) {
    const chat = createChatServer({ pool: db, jwtSecret: key, logger: { error: line => logs.push(line) } });
    servers.push(chat);
    const { port } = await chat.listen();
    return `http://127.0.0.1:${port}`;
  }
  const url = await start();
  async function request(path, method = "GET", body, token, origin = url) {
    const response = await fetch(origin + path, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    assert.ok(!text.includes(key) && !text.includes(password), "Credential exposed (withheld)");
    return { status: response.status, body: JSON.parse(text) };
  }
  const alice = await request("/api/auth/register", "POST", { username: "profile_alice", displayName: "Alice", password });
  const bob = await request("/api/auth/register", "POST", { username: "profile_bob", displayName: "Bob", password });
  assert.equal(alice.status, 201);
  assert.equal(bob.status, 201);
  let token = alice.body.token;
  const login = async () => {
    const result = await request("/api/auth/login", "POST", { username: "profile_alice", password });
    assert.equal(result.status, 200);
    return result.body.token;
  };

  await t.test("uses only the guarded database and a private migrated schema", async () => {
    const { rows: [row] } = await pool.query("SELECT current_database() AS name, current_schema() AS schema");
    assert.equal(row.name, env.PGDATABASE);
    assert.equal(row.schema, schema);
  });

  await t.test("updates Unicode profiles, preserves unrelated account data and persists through relogin", async () => {
    const { rows: [before] } = await pool.query("SELECT username, password_hash, created_at, updated_at FROM users WHERE id = $1", [alice.body.user.id]);
    const patch = { displayName: "🐱".repeat(64), statusMessage: "🔒".repeat(280) };
    const saved = await request("/api/users/me", "PATCH", patch, token);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.user.display_name, patch.displayName);
    assert.equal(saved.body.user.status_message, patch.statusMessage);
    assert.equal((await request("/api/users/me", "PATCH", { displayName: "x".repeat(65) }, token)).status, 400);
    assert.equal((await request("/api/users/me", "PATCH", { statusMessage: "x".repeat(281) }, token)).status, 400);
    const { rows: [after] } = await pool.query("SELECT username, password_hash, created_at, updated_at FROM users WHERE id = $1", [alice.body.user.id]);
    assert.equal(after.password_hash === before.password_hash, true, "Hash must remain unchanged (withheld)");
    assert.equal(after.username, before.username);
    assert.equal(after.created_at.getTime(), before.created_at.getTime());
    assert.ok(after.updated_at >= before.updated_at);
    assert.equal((await request("/api/auth/logout", "POST", {}, token)).status, 200);
    assert.equal((await request("/api/users/me", "GET", undefined, token)).body.code, "AUTH_REVOKED");
    assert.equal((await request("/api/users/me", "PATCH", { displayName: "Denied" }, token)).body.code, "AUTH_REVOKED");
    token = await login();
    // New HTTP connection plus a real logout/new login reads PostgreSQL again.
    assert.deepEqual((await request("/api/users/me", "GET", undefined, token)).body, saved.body);
  });

  await t.test("Unicode whitespace-only names return 400 without changing stored profiles", async () => {
    const before = await request("/api/users/me", "GET", undefined, token);
    // PostgreSQL POSIX whitespace classes depend on locale. The API's Unicode
    // validation must reject these names regardless of that classification.
    for (const displayName of ["\u0085", "\t\u0085\u2003\n", "\u0085".repeat(64)]) {
      const denied = await request("/api/users/me", "PATCH", { displayName }, token);
      assert.equal(denied.status, 400);
      assert.equal(denied.body.code, "INVALID_INPUT");
    }
    // Exercise the actual database CHECK with portable empty/ASCII whitespace
    // cases, rather than prescribing how its locale must classify U+0085.
    for (const displayName of ["", " \t\r\n"]) {
      await assert.rejects(
        pool.query("UPDATE users SET display_name = $1 WHERE id = $2::uuid", [displayName, alice.body.user.id]),
        error => error.code === "23514",
      );
    }
    assert.deepEqual((await request("/api/users/me", "GET", undefined, token)).body, before.body);
    const displayName = "\u0085" + "猫".repeat(63);
    const valid = await request("/api/users/me", "PATCH", { displayName }, token);
    assert.equal(valid.status, 200);
    assert.equal(valid.body.user.display_name, displayName);
    assert.equal(valid.body.user.status_message, before.body.user.status_message);
    assert.equal((await request("/api/users/me", "PATCH", { displayName: displayName + "猫" }, token)).status, 400);
  });

  await t.test("other authenticated users see public profiles while credentials remain private", async () => {
    const status = "<img src=x onerror=alert(1)> literal public text";
    const result = await request("/api/users/me", "PATCH", { displayName: "  Alice e\u0301  ", statusMessage: status }, token);
    assert.equal(result.status, 200);
    const found = await request("/api/users?q=alice", "GET", undefined, bob.body.token);
    assert.deepEqual(found.body.users, [result.body.user]);
    assert.deepEqual(Object.keys(found.body.users[0]).sort(), ["display_name", "id", "status_message", "username"]);
    const serialized = JSON.stringify(found.body);
    const { rows: [privateUser] } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [alice.body.user.id]);
    assert.ok([privateUser.password_hash, token, bob.body.token].every(value => !serialized.includes(value)), "Private field exposed (withheld)");
    assert.equal((await request("/api/users/me", "PATCH", { id: bob.body.user.id, displayName: "Denied" }, token)).status, 400);
    assert.equal((await request("/api/users/me", "GET", undefined, bob.body.token)).body.user.display_name, "Bob");
    assert.equal((await request("/api/users/me", "PATCH", { statusMessage: "" }, token)).body.user.status_message, null);
    assert.equal((await request("/api/users/me", "GET", undefined, token)).body.user.display_name, "  Alice e\u0301  ");
    assert.ok(!JSON.stringify(logs).includes(status), "Profile text must not be logged");
  });

  await t.test("profile writes and logout contend on the session lock in both orders", async () => {
    for (const logoutFirst of [true, false]) {
      const auth = await login();
      const initial = await request("/api/users/me", "PATCH", { statusMessage: "Before race" }, auth);
      assert.equal(initial.status, 200);
      const locked = deferred();
      const release = deferred();
      const attempted = deferred();
      let holder;
      let waiter;
      let secondDone = false;
      function wrapper(first) {
        return {
          query: (...args) => pool.query(...args),
          async connect() {
            const client = await pool.connect();
            return { release: error => client.release(error), async query(sql, values) {
              const targetLock = first
                ? logoutFirst ? sql.includes("FROM user_sessions") && sql.endsWith("FOR UPDATE") : sql.includes("FOR SHARE OF s")
                : logoutFirst ? sql.includes("FOR SHARE OF s") : sql.includes("FROM user_sessions") && sql.endsWith("FOR UPDATE");
              if (targetLock && !first) { waiter = client.processID; attempted.resolve(); }
              const result = await client.query(sql, values);
              if (sql === "BEGIN") await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'");
              if (targetLock && first) { holder = client.processID; locked.resolve(); await bounded(release.promise, "Profile session gate timed out"); }
              return result;
            } };
          },
        };
      }
      const firstUrl = await start(wrapper(true));
      const secondUrl = await start(wrapper(false));
      const write = origin => request("/api/users/me", "PATCH", { statusMessage: "Race saved" }, auth, origin);
      const logout = origin => request("/api/auth/logout", "POST", {}, auth, origin);
      const first = logoutFirst ? logout(firstUrl) : write(firstUrl);
      let second;
      let results;
      try {
        await bounded(locked.promise, "First profile session lock was not acquired");
        second = (logoutFirst ? write(secondUrl) : logout(secondUrl)).then(result => { secondDone = true; return result; });
        await bounded(attempted.promise, "Competing profile session lock was not attempted");
        assert.notEqual(holder, waiter);
        await (async () => {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            const { rows: [row] } = await pool.query(
              "SELECT wait_event_type, $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1::int", [waiter, holder]);
            if (row?.wait_event_type === "Lock" && row.blocked) return;
            await new Promise(done => setTimeout(done, 15));
          }
          throw new Error("PostgreSQL did not report actual session lock contention");
        })();
        assert.equal(secondDone, false);
      } finally {
        release.resolve();
        results = await bounded(Promise.all([first, second].filter(Boolean)), "Profile race did not finish");
      }
      assert.equal(results[0].status, 200);
      assert.equal(results[1].status, logoutFirst ? 401 : 200);
      if (logoutFirst) assert.equal(results[1].body.code, "AUTH_REVOKED");
      const { rows: [user] } = await pool.query("SELECT status_message FROM users WHERE id = $1", [alice.body.user.id]);
      assert.equal(user.status_message, logoutFirst ? "Before race" : "Race saved");
    }
  });
});
