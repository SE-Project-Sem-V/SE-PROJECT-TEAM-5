const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const {
  ERROR_CATALOGUE, AppError, normalizeError, httpErrorResponse,
  socketErrorResponse, socketConnectionError, messageValidationError,
} = require("../errors");
const { validateMessage } = require("../services/message-service");

test("the public catalogue provides consistent HTTP, ACK and connection errors", () => {
  assert.equal(Object.keys(ERROR_CATALOGUE).length, 20);
  for (const [code, definition] of Object.entries(ERROR_CATALOGUE)) {
    const error = new AppError(code);
    assert.equal(error instanceof Error, true);
    assert.deepEqual(httpErrorResponse(error), {
      status: definition.status, body: { status: "error", code, message: definition.message },
    });
    assert.deepEqual(socketErrorResponse(error), {
      ok: false, code, message: definition.message, error: definition.message,
    });
    const connectionError = socketConnectionError(error);
    assert.equal(connectionError instanceof Error, true);
    assert.equal(connectionError.message, definition.message);
    assert.deepEqual(connectionError.data, { code, message: definition.message });
    assert.equal(Object.isFrozen(definition), true);
  }
});

test("unknown errors and forged application errors cannot expose exception fields", () => {
  const privateValue = randomBytes(32).toString("hex");
  const forged = Object.assign(Object.create(AppError.prototype), {
    code: "ROOM_FORBIDDEN", status: 403, message: privateValue,
  });
  for (const error of [undefined, null, privateValue, 42, new Error(privateValue), forged,
    { code: "RECIPIENT_NOT_FOUND", status: 404, message: privateValue, detail: privateValue },
    { get code() { throw new Error("Must not read exception properties"); } }]) {
    const response = httpErrorResponse(error);
    assert.ok(!JSON.stringify(response).includes(privateValue), "Private details exposed (withheld)");
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "INTERNAL_ERROR");
  }
  assert.equal(normalizeError(new AppError("toString")).code, "INTERNAL_ERROR");
});

test("mutating a recognized error or supplying an arbitrary variant cannot change its public message", () => {
  const privateValue = randomBytes(32).toString("hex");
  const error = new AppError("ROOM_FORBIDDEN", privateValue);
  error.message = privateValue;
  error.code = privateValue;
  error.status = 200;
  const response = httpErrorResponse(error);
  assert.ok(!JSON.stringify(response).includes(privateValue), "Private details exposed (withheld)");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "ROOM_FORBIDDEN");
});

test("CHATAPP-27 validation explanations map to INVALID_MESSAGE without accepting request text", () => {
  const sender = "11111111-1111-4111-8111-111111111111";
  const recipient = "22222222-2222-4222-8222-222222222222";
  const valid = { to: recipient, text: "hello", clientId: "id" };
  const cases = [
    [null, sender], [[], sender], [{ ...valid, roomId: recipient }, sender],
    [valid, "invalid"], [{ ...valid, to: "invalid" }, sender],
    [{ ...valid, to: sender }, sender], [{ ...valid, text: " " }, sender],
    [{ ...valid, text: "x".repeat(11) }, sender], [{ ...valid, clientId: "" }, sender],
  ];
  for (const [payload, userId] of cases) {
    const explanation = validateMessage(payload, userId, 10);
    const ack = socketErrorResponse(messageValidationError(explanation, 10));
    assert.equal(ack.code, "INVALID_MESSAGE");
    assert.equal(ack.error, explanation);
    assert.equal(ack.message, ack.error);
  }
  const privateValue = randomBytes(32).toString("hex");
  assert.ok(!JSON.stringify(socketErrorResponse(messageValidationError(privateValue, 10))).includes(privateValue));
  assert.equal(normalizeError(messageValidationError("untrusted", NaN)).code, "INVALID_MESSAGE");
});

