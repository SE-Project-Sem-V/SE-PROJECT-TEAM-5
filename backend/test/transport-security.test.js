const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { io } = require("socket.io-client");
const { createTransportPolicy, TransportConfigurationError } = require("../security/transport");
const { createChatServer } = require("../server");
const { issueSession } = require("../services/session-service");
const { memorySessions } = require("./helpers/session-fixtures");

const local = { NODE_ENV: "test", TRANSPORT_MODE: "local" };
const proxy = { NODE_ENV: "production", TRANSPORT_MODE: "proxy",
  TRUSTED_PROXY_IPS: "127.0.0.1", CLIENT_URL: "https://chat.example.invalid" };
const httpsHeaders = { "X-Forwarded-Proto": "https" };
const enginePath = "/socket.io/?EIO=4&transport=polling";

function request(url, path = "/api/ping", { headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    if (Array.isArray(headers)) headers = ["Host", new URL(url).host, ...headers];
    const req = http.request(new URL(path, url), { method, headers, agent: false }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
      res.on("error", reject);
    });
    req.setTimeout(2500, () => req.destroy(new Error("Transport test request timed out")));
    req.on("error", reject);
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("Unexpected insecure WebSocket upgrade"));
    });
    req.end(body);
  });
}

async function fixture(t, env = local) {
  const sessions = memorySessions();
  const key = randomBytes(32).toString("hex");
  const sender = randomUUID();
  const recipient = randomUUID();
  const room = randomUUID();
  const state = { reads: 0, writes: 0, committed: false };
  const logs = [];
  const pool = {
    async query(sql, values) {
      state.reads += 1;
      const result = sessions.query(sql, values);
      if (result) return result;
      if (sql === "COMMIT") state.committed = true;
      if (sql.includes("FROM chat_rooms")) return { rowCount: 1, rows: [{ id: room }] };
      if (sql.includes("FROM room_members")) return { rowCount: 2, rows: [
        { user_id: sender, left_at: null }, { user_id: recipient, left_at: null },
      ] };
      if (sql.includes("INSERT INTO messages")) {
        state.writes += 1;
        return { rows: [{ id: randomUUID(), room_id: room, sender_id: values[1],
          content: values[2], created_at: new Date() }] };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  const chat = createChatServer({ pool, jwtSecret: key, transportEnv: env,
    logger: { error: value => logs.push(value) } });
  t.after(() => chat.close());
  const { port } = await chat.listen();
  return { chat, pool, key, sessions, sender, recipient, state, logs,
    url: `http://127.0.0.1:${port}` };
}

function connect(t, f, token, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(f.url, { auth: { token }, reconnection: false,
      timeout: 2000, forceNew: true, ...options });
    t.after(() => socket.disconnect());
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", () => { socket.disconnect(); reject(new Error("Unexpected socket rejection")); });
  });
}

function ack(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(event, ...args, (error, response) => {
      if (error) reject(new Error("Transport test ACK timed out"));
      else resolve(response);
    });
  });
}

function onceEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const onEvent = value => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error("Transport test event timed out"));
    }, 2500);
    socket.once(event, onEvent);
  });
}

test("transport configuration fails closed for public listeners, production local mode and broad proxy trust", () => {
  for (const changes of [
    { BACKEND_HOST: "0.0.0.0" }, { BACKEND_HOST: "::" }, { BACKEND_HOST: "192.0.2.1" },
    { BACKEND_HOST: "localhost" }, { TRANSPORT_MODE: "unknown" }, { NODE_ENV: "production" },
    { NODE_ENV: "staging" }, { TRUSTED_PROXY_IPS: "127.0.0.1" },
  ]) assert.throws(() => createTransportPolicy({ ...local, ...changes }), TransportConfigurationError);
  for (const changes of [
    { TRUSTED_PROXY_IPS: "" }, { TRUSTED_PROXY_IPS: "*" }, { TRUSTED_PROXY_IPS: "true" },
    { TRUSTED_PROXY_IPS: "127.0.0.0/8" }, { TRUSTED_PROXY_IPS: "192.0.2.1" },
    { TRUSTED_PROXY_IPS: "127.0.0.1," }, { TRUSTED_PROXY_IPS: "127.0.0.1,::ffff:127.0.0.1" },
    { CLIENT_URL: undefined }, { CLIENT_URL: "http://localhost:5173" },
    { CLIENT_URL: "https://user:password@chat.example.invalid" },
    { CLIENT_URL: "https://chat.example.invalid/?secret=private" },
    { CLIENT_URL: "not a URL" }, { CLIENT_URL: "https://@chat.example.invalid" },
    { CLIENT_URL: "https://chat.example.invalid/path" }, { CLIENT_URL: "ftp://chat.example.invalid" },
  ]) assert.throws(() => createTransportPolicy({ ...proxy, ...changes }), TransportConfigurationError);
  assert.equal(createTransportPolicy({ ...proxy, TRANSPORT_MODE: undefined }).mode, "proxy");
});

test("invalid production transport fails startup with only a controlled configuration log", () => {
  const key = randomBytes(32).toString("hex");
  for (const settings of [{ TRANSPORT_MODE: "local" }, { TRANSPORT_MODE: "proxy", TRUSTED_PROXY_IPS: "" },
    { TRANSPORT_MODE: "proxy", TRUSTED_PROXY_IPS: "*" }]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, NODE_ENV: "production", JWT_SECRET: key, ...settings },
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), '{"level":"error","event":"server.start.failed","code":"CONFIG_FAILURE"}');
  }
});

test("local policy checks actual IPv4/IPv6 peers, ignoring spoofed host and forwarding headers", () => {
  const policy = createTransportPolicy(local);
  for (const peer of ["127.0.0.1", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(policy.allows({ socket: { remoteAddress: peer } }), true);
  }
  for (const peer of [undefined, "localhost", "127.0.0.1.evil", "192.0.2.1", "::ffff:192.0.2.1", "::"]) {
    assert.equal(policy.allows({ socket: { remoteAddress: peer },
      headers: { host: "localhost", "x-forwarded-for": "127.0.0.1", ...httpsHeaders } }), false);
  }
});

test("proxy policy accepts only exact trusted TCP peers and one unambiguous HTTPS assertion", () => {
  const policy = createTransportPolicy({ ...proxy, TRUSTED_PROXY_IPS: "127.0.0.1,::1" });
  const req = { socket: { remoteAddress: "::ffff:127.0.0.1" }, rawHeaders: ["X-Forwarded-Proto", "https"] };
  assert.equal(policy.allows(req), true);
  assert.equal(policy.allows({ ...req, socket: { remoteAddress: "::1" } }), true);
  for (const peer of ["127.0.0.2", "192.0.2.1", "::ffff:192.0.2.1"]) {
    assert.equal(policy.allows({ ...req, socket: { remoteAddress: peer } }), false);
  }
  for (const rawHeaders of [[], ["X-Forwarded-Proto", "http"], ["X-Forwarded-Proto", "HTTPS"],
    ["X-Forwarded-Proto", "https,http"], ["X-Forwarded-Proto", "https", "x-forwarded-proto", "https"],
    ["X-Forwarded-Proto", "https", "Forwarded", "proto=https"], ["Forwarded", "proto=https"]]) {
    assert.equal(policy.allows({ ...req, rawHeaders }), false);
  }
});

test("local HTTP works and factory listener overrides cannot expose plaintext publicly", async t => {
  const f = await fixture(t);
  assert.equal((await request(f.url)).status, 200);
  assert.equal(f.chat.app.get("trust proxy"), false);
  assert.throws(() => f.chat.listen(0, "0.0.0.0"), TransportConfigurationError);
  assert.throws(() => f.chat.listen(0, "::"), TransportConfigurationError);
});

test("IPv6 loopback HTTP works without widening the listener", async t => {
  const f = await fixture(t, { ...local, BACKEND_HOST: "::1" });
  const { port } = f.chat.server.address();
  assert.equal((await request(`http://[::1]:${port}`)).status, 200);
});

test("HTTP rejects insecure or ambiguous proxy assertions before parsing bodies or authenticating", async t => {
  const f = await fixture(t, proxy);
  const secret = randomBytes(32).toString("hex");
  for (const headers of [{}, { "X-Forwarded-Proto": "http" }, { "X-Forwarded-Proto": "https,http" },
    { ...httpsHeaders, Forwarded: `proto=https;secret=${secret}` },
    ["X-Forwarded-Proto", "https", "x-forwarded-proto", "https"]]) {
    const result = await request(f.url, "/api/auth/login", {
      method: "POST", headers: Array.isArray(headers) ? [...headers, "Content-Type", "application/json"]
        : { ...headers, "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: `{"password":${secret}`,
    });
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.text), { status: "error", code: "SECURE_TRANSPORT_REQUIRED",
      message: "Secure HTTPS/WSS transport is required." });
    assert.ok(!result.text.includes(secret), "Sensitive response data exposed (withheld)");
  }
  assert.equal(f.state.reads, 0);
  assert.ok(f.logs.length > 0);
  assert.ok(f.logs.every(line => line === '{"level":"error","event":"http.request.failed","code":"SECURE_TRANSPORT_REQUIRED","status":403}'));
  assert.equal((await request(f.url, "/api/ping", { headers: httpsHeaders })).status, 200);
  // An allowed request still encounters real authentication, not a TLS bypass.
  assert.equal((await request(f.url, "/api/users?q=alice", { headers: httpsHeaders })).status, 401);
});

test("real HTTP and Engine.IO reject forged HTTPS headers from an untrusted TCP peer", async t => {
  const f = await fixture(t, { ...proxy, TRUSTED_PROXY_IPS: "::1" });
  const token = await issueSession(f.pool, f.sender, f.key);
  f.state.reads = 0;
  for (const [path, expected] of [["/api/ping", 403], [enginePath, 400]]) {
    const result = await request(f.url, path, { headers: { ...httpsHeaders,
      "X-Forwarded-For": "::1", Host: "localhost" } });
    assert.equal(result.status, expected);
  }
  for (const transport of ["polling", "websocket"]) {
    // Even a legitimate session must never reach namespace authentication on
    // an insecure/untrusted transport. Use an actual Socket.IO client here.
    await new Promise((resolve, reject) => {
      const socket = io(f.url, { auth: { token }, transports: [transport],
        extraHeaders: httpsHeaders, reconnection: false, forceNew: true, timeout: 2000 });
      t.after(() => socket.disconnect());
      socket.once("connect", () => { socket.disconnect(); reject(new Error("Untrusted socket connected")); });
      socket.once("connect_error", () => { socket.disconnect(); resolve(); });
    });
  }
  assert.equal(f.state.reads, 0);
  assert.ok(f.logs.every(line => line === '{"level":"error","event":"http.request.failed","code":"SECURE_TRANSPORT_REQUIRED","status":403}'));
});

test("Engine.IO guards initial polling, continuation GET/POST and upgrades before authentication", async t => {
  const f = await fixture(t, proxy);
  const token = await issueSession(f.pool, f.sender, f.key);
  f.state.reads = 0;
  const denied = await request(f.url, enginePath);
  assert.equal(denied.status, 400);
  assert.deepEqual(JSON.parse(denied.text), { code: 3, message: "Bad request" });
  assert.equal((await request(f.url, "/socket.io/socket.io.js")).status, 400);
  const open = await request(f.url, enginePath, { headers: httpsHeaders });
  assert.equal(open.status, 200);
  const sid = JSON.parse(open.text.slice(1)).sid;
  for (const options of [{}, { method: "POST", headers: { "Content-Type": "text/plain" },
    body: `40${JSON.stringify({ token })}` }]) {
    assert.equal((await request(f.url, `${enginePath}&sid=${sid}`, options)).status, 400);
  }
  for (const suffix of ["", `&sid=${sid}`]) {
    const result = await request(f.url, `/socket.io/?EIO=4&transport=websocket${suffix}`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64") },
    });
    assert.equal(result.status, 400);
    assert.equal(result.text, "Bad request");
  }
  assert.equal(f.state.reads, 0);
});

for (const mode of ["local", "proxy"]) {
  test(`${mode} Engine.IO preflights preserve CORS after transport validation`, async t => {
    const env = mode === "local" ? { ...local, CLIENT_URL: "http://localhost:5173" } : proxy;
    const f = await fixture(t, env);
    const result = await request(f.url, enginePath, {
      method: "OPTIONS", headers: {
        ...(mode === "proxy" ? httpsHeaders : {}), Origin: env.CLIENT_URL,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(result.status, 204);
    assert.equal(result.text, "");
    assert.equal(result.headers["access-control-allow-origin"], env.CLIENT_URL);
    assert.equal(result.headers["access-control-allow-methods"], "GET,POST");
    assert.equal(result.headers["access-control-allow-headers"], "authorization,content-type");
    assert.equal(f.state.reads, 0);
    assert.equal(f.chat.io.engine.clientsCount, 0);
    assert.deepEqual(f.logs, []);
  });
}

test("Engine.IO preflights reject missing, insecure, malformed and ambiguous proxy assertions", async t => {
  const f = await fixture(t, proxy);
  const preflightHeaders = ["Origin", proxy.CLIENT_URL, "Access-Control-Request-Method", "POST"];
  const cases = [[], ["X-Forwarded-Proto", "http"], ["X-Forwarded-Proto", "HTTPS"],
    ["X-Forwarded-Proto", "https,http"], ["X-Forwarded-Proto", ""],
    ["X-Forwarded-Proto", "https", "x-forwarded-proto", "https"],
    ["X-Forwarded-Proto", "https", "x-forwarded-proto", "http"],
    ["X-Forwarded-Proto", "https", "fOrWaRdEd", "proto=https"],
    ["Forwarded", "proto=https", "X-Forwarded-For", "127.0.0.1"]];
  for (const headers of cases) {
    const result = await request(f.url, enginePath, {
      method: "OPTIONS", headers: [...preflightHeaders, ...headers],
    });
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.text), { code: 3, message: "Bad request" });
  }
  assert.equal(f.state.reads, 0);
  assert.equal(f.chat.io.engine.clientsCount, 0);
  assert.equal(f.logs.length, cases.length);
  assert.ok(f.logs.every(line => line === '{"level":"error","event":"http.request.failed","code":"SECURE_TRANSPORT_REQUIRED","status":403}'));
});

test("Engine.IO preflights cannot forge a trusted TCP peer with forwarding headers", async t => {
  const f = await fixture(t, { ...proxy, TRUSTED_PROXY_IPS: "::1" });
  const result = await request(f.url, enginePath, {
    method: "OPTIONS", headers: { ...httpsHeaders, Origin: proxy.CLIENT_URL,
      "Access-Control-Request-Method": "POST", "X-Forwarded-For": "::1", Host: "localhost" },
  });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.text), { code: 3, message: "Bad request" });
  assert.equal(f.state.reads, 0);
  assert.equal(f.chat.io.engine.clientsCount, 0);
  assert.deepEqual(f.logs, ['{"level":"error","event":"http.request.failed","code":"SECURE_TRANSPORT_REQUIRED","status":403}']);
});

test("Express and Socket.IO CORS use the browser's canonical CLIENT_URL origin", async t => {
  for (const [env, expected] of [
    [{ ...proxy, CLIENT_URL: "https://frontend.example.invalid/" }, "https://frontend.example.invalid"],
    [{ ...proxy, CLIENT_URL: "https://FRONTEND.EXAMPLE.INVALID" }, "https://frontend.example.invalid"],
    [{ ...proxy, CLIENT_URL: "HTTPS://FRONTEND.EXAMPLE.INVALID:443/" }, "https://frontend.example.invalid"],
    [{ ...local, CLIENT_URL: "http://LOCALHOST:5173/" }, "http://localhost:5173"],
  ]) {
    assert.equal(createTransportPolicy(env).clientOrigin, expected);
    const f = await fixture(t, env);
    const headers = { ...(env.TRANSPORT_MODE === "proxy" ? httpsHeaders : {}), Origin: expected };
    for (const path of ["/api/ping", enginePath]) {
      const response = await request(f.url, path, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers["access-control-allow-origin"], expected);
      const preflight = await request(f.url, path, {
        method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Method": "POST" },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers["access-control-allow-origin"], expected);
    }
    assert.equal(f.state.reads, 0);
  }
});

for (const mode of ["local", "proxy"]) {
  for (const transport of ["polling", "websocket"]) {
    test(`${mode} ${transport} preserves session authentication, message ACKs/delivery and logout`, { timeout: 10000 }, async t => {
      const f = await fixture(t, mode === "local" ? local : proxy);
      const token = await issueSession(f.pool, f.sender, f.key);
      const recipientToken = await issueSession(f.pool, f.recipient, f.key);
      const headers = mode === "proxy" ? httpsHeaders : {};
      const options = { transports: [transport], extraHeaders: headers };
      const recipient = await connect(t, f, recipientToken, options);
      const sender = await connect(t, f, token, options);
      assert.deepEqual(await ack(sender, "protected:ping"), {
        status: "success", message: "pong", userId: f.sender,
      });
      const delivered = onceEvent(recipient, "newMessage");
      const result = await ack(sender, "sendMessage", { to: f.recipient, text: "Transport regression", clientId: randomUUID() });
      assert.equal(result.ok, true);
      assert.equal(result.message.text, "Transport regression");
      assert.deepEqual(await delivered, result.message);
      assert.equal(f.state.writes, 1);
      assert.equal(f.state.committed, true);
      const disconnected = onceEvent(sender, "disconnect");
      const logout = await request(f.url, "/api/auth/logout", {
        method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` },
      });
      assert.equal(logout.status, 200);
      assert.deepEqual(JSON.parse(logout.text), { status: "success" });
      await disconnected;
      const revoked = await request(f.url, "/api/users?q=alice", { headers: { ...headers, Authorization: `Bearer ${token}` } });
      assert.equal(revoked.status, 401);
      assert.equal(JSON.parse(revoked.text).code, "AUTH_REVOKED");
      assert.equal((await ack(recipient, "protected:ping")).status, "success");
    });
  }
}

test("a trusted HTTPS polling connection can upgrade normally to WebSocket", { timeout: 8000 }, async t => {
  const f = await fixture(t, proxy);
  const token = await issueSession(f.pool, f.sender, f.key);
  const socket = await connect(t, f, token, {
    transports: ["polling", "websocket"], extraHeaders: httpsHeaders,
  });
  if (socket.io.engine.transport.name !== "websocket") await onceEvent(socket.io.engine, "upgrade");
  assert.equal(socket.io.engine.transport.name, "websocket");
  assert.equal((await ack(socket, "protected:ping")).status, "success");
});
