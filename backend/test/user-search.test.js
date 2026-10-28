const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { createChatServer } = require("../server");

async function fixture(t, query) {
  const key = randomBytes(32).toString("hex");
  const userId = randomUUID();
  const calls = [];
  const logs = [];
  const pool = {
    connect() { assert.fail("HTTP search must use the existing pool without opening a transaction"); },
    async query(sql, values) {
      calls.push({ sql, values });
      if (query) return query(sql, values, userId);
      return { rows: values.length === 1 ? [{ id: userId }] : [] };
    },
  };
  const chat = createChatServer({
    pool, jwtSecret: key, logger: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });
  t.after(() => chat.close());
  const address = await chat.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const token = jwt.sign({ sub: userId }, key, { expiresIn: "2m" });
  async function request(suffix = "?q=ali", authorization = `Bearer ${token}`) {
    const response = await fetch(`${url}/api/users${suffix}`, {
      headers: authorization === null ? {} : { Authorization: authorization },
      signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    // Never print ephemeral keys/tokens in assertion diagnostics, even on failure.
    assert.ok(!text.includes(key) && !text.includes(token), "Credential in response (withheld)");
    return { response, body: JSON.parse(text) };
  }
  return { key, token, userId, calls, logs, request, url };
}

function safeFailure(result, status, message, code = status === 500 ? "INTERNAL_ERROR" : "AUTH_INVALID") {
  assert.equal(result.response.status, status);
  assert.deepEqual(result.body, { status: "error", code, message });
  assert.equal(result.response.headers.get("cache-control"), "no-store");
}

test("HTTP search accepts a signed bearer token and returns only public fields", async (t) => {
  const privateValue = randomBytes(32).toString("hex");
  const resultId = randomUUID();
  const f = await fixture(t, (_sql, values, userId) => ({ rows: values.length === 1
    ? [{ id: userId }]
    : [{ id: resultId, username: "Alina", password_hash: privateValue, email: privateValue, status_message: privateValue, token: privateValue }],
  }));
  const result = await f.request("?q=ali", `bearer ${f.token}`);
  assert.equal(result.response.status, 200);
  assert.ok(!JSON.stringify(result.body).includes(privateValue), "Private field in response (withheld)");
  assert.deepEqual(result.body, { users: [{ id: resultId, username: "Alina" }] });
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(f.calls.length, 2);
});

test("missing or malformed HTTP authorization is rejected before database access", async (t) => {
  const f = await fixture(t);
  for (const header of [null, "", "Bearer", "Basic invalid", "Bearer invalid", "Bearer one two"]) {
    const result = await f.request("?q=ali", header);
    safeFailure(result, 401, "Authentication required.", header === null ? "AUTH_REQUIRED" : "AUTH_INVALID");
    assert.equal(result.response.headers.get("www-authenticate"), "Bearer");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 0);
});

test("HTTP search rejects expired, tampered, premature, unsigned and wrong-algorithm tokens", async (t) => {
  const f = await fixture(t);
  const [header, payload, signature] = f.token.split(".");
  const tampered = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const tokens = [
    jwt.sign({ sub: f.userId }, f.key, { expiresIn: -1 }), tampered,
    jwt.sign({ sub: f.userId }, randomBytes(32).toString("hex"), { expiresIn: "2m" }),
    jwt.sign({ sub: f.userId }, f.key, { notBefore: "1h", expiresIn: "2h" }),
    jwt.sign({ sub: f.userId }, "", { algorithm: "none" }),
    jwt.sign({ sub: f.userId }, f.key, { algorithm: "HS384" }),
  ];
  for (const [index, token] of tokens.entries()) {
    safeFailure(await f.request("?q=ali", `Bearer ${token}`), 401, "Authentication required.",
      index === 0 ? "AUTH_EXPIRED" : "AUTH_INVALID");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 0);
});

test("HTTP subjects must be UUID strings before they reach PostgreSQL", async (t) => {
  const f = await fixture(t);
  for (const sub of [undefined, null, "", 123, {}, [], "not-a-uuid", "' OR TRUE --", "00000000-0000-0000-0000-000000000000"]) {
    const token = jwt.sign(sub === undefined ? {} : { sub }, f.key, { expiresIn: "2m" });
    safeFailure(await f.request("?q=ali", `Bearer ${token}`), 401, "Authentication required.");
  }
  safeFailure(await f.request("?q=ali", `Bearer ${jwt.sign("text payload", f.key)}`), 401, "Authentication required.");
  assert.equal(f.calls.length, 0);
});

test("a signed subject must belong to an existing user", async (t) => {
  const f = await fixture(t, () => ({ rows: [] }));
  safeFailure(await f.request(), 401, "Authentication required.");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].values, [f.userId]);
});

test("duplicate Authorization headers are rejected rather than choosing an identity", async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${f.url}/api/users?q=ali`, {
      headers: ["Host", new URL(f.url).host, "Authorization", `Bearer ${f.token}`, "Authorization", `Bearer ${f.token}`],
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("HTTP test timed out")));
    req.end();
  });
  assert.equal(status, 401);
  assert.equal(f.calls.length, 0);
});

test("empty searches still require authentication", async (t) => {
  const f = await fixture(t);
  safeFailure(await f.request("?q=", null), 401, "Authentication required.", "AUTH_REQUIRED");
  safeFailure(await f.request("?q[]=invalid", null), 401, "Authentication required.", "AUTH_REQUIRED");
  assert.equal(f.calls.length, 0);
});

test("missing, empty and whitespace-only q return an empty list without directory queries", async (t) => {
  const f = await fixture(t);
  for (const suffix of ["", "?q=", "?q=%20%09%20"]) {
    const result = await f.request(suffix);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { users: [] });
  }
  assert.equal(f.calls.length, 3); // Only the authenticated-user existence checks.
});

test("malformed, repeated, structured, unknown and oversized query parameters return 400", async (t) => {
  const f = await fixture(t);
  for (const suffix of [
    "?q=a&q=b", "?q[]=a", "?q[name]=a", "?q%5B0%5D=a", "?q=a&limit=100",
    "?token=invalid", "?q=%", "?q=%GG", "?q=%FF", "?q=a%00b", "?q=a%0Ab", "?q=a%7Fb",
    `?q=${"a".repeat(65)}`, `?q=${"%20".repeat(2)}${"a".repeat(65)}%20`,
    `?q=a&${"q=b&".repeat(1001)}`,
  ]) {
    const result = await f.request(suffix);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.code, "INVALID_INPUT");
    assert.ok(result.body.message.startsWith("Use a single q parameter"));
  }
  assert.ok(f.calls.every(({ values }) => values.length === 1));
  assert.equal(f.logs.length, 0);
});

test("search trims whitespace and accepts the 64-character boundary", async (t) => {
  const f = await fixture(t);
  const query = "a".repeat(64);
  const result = await f.request(`?q=${encodeURIComponent(`  ${query}  `)}`);
  assert.equal(result.response.status, 200);
  assert.deepEqual(f.calls[1].values, [f.userId, `%${query}%`, 20]);
});

test("SQL input stays in bound parameters and LIKE wildcards are escaped", async (t) => {
  const f = await fixture(t);
  const query = "a!_%\\' OR TRUE --";
  const result = await f.request(`?q=${encodeURIComponent(query)}`);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { users: [] });
  const search = f.calls[1];
  assert.ok(!search.sql.includes(query));
  assert.deepEqual(search.values, [f.userId, "%a!!!_!%\\' OR TRUE --%", 20]);
});

for (const phase of ["authentication", "search"]) {
  test(`${phase} database failures use the credential-safe HTTP handler`, async (t) => {
    const privateValue = randomBytes(32).toString("hex");
    const f = await fixture(t, (_sql, values, userId) => {
      if (phase === "authentication" || values.length > 1) {
        throw Object.assign(new Error(privateValue), { detail: privateValue, code: "28P01" });
      }
      return { rows: [{ id: userId }] };
    });
    const result = await f.request(`?q=${privateValue}`);
    const output = JSON.stringify([result.body, f.logs, [...result.response.headers]]);
    assert.ok([privateValue, f.key, f.token].every((value) => !output.includes(value)), "Sensitive failure details exposed (withheld)");
    safeFailure(result, 500, "Internal server error.");
    assert.deepEqual(f.logs, [["[http] Request failed:", 500]]);
  });
}
