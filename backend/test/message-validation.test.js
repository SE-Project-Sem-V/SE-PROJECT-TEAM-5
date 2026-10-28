const assert = require("node:assert/strict");
const test = require("node:test");

const { validateMessage } = require("../services/message-service");

const senderId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";
const validPayload = {
  to: recipientId,
  text: "Hello",
  clientId: "client-123",
};

test("accepts a valid direct-message payload", () => {
  assert.equal(validateMessage(validPayload, senderId, 1000), null);
});

test("rejects null, arrays and non-object payloads", () => {
  for (const payload of [null, [], "hello", 42]) {
    assert.equal(
      validateMessage(payload, senderId, 1000),
      "Invalid message payload.",
    );
  }
});

test("rejects unexpected fields including client-supplied sender IDs", () => {
  assert.equal(
    validateMessage({ ...validPayload, senderId }, senderId, 1000),
    "Invalid message payload.",
  );
  assert.equal(
    validateMessage({ ...validPayload, roomId: recipientId }, senderId, 1000),
    "Invalid message payload.",
  );
});

test("rejects invalid sender and recipient identifiers", () => {
  assert.match(
    validateMessage(validPayload, "not-a-uuid", 1000),
    /account cannot send/i,
  );
  assert.match(
    validateMessage({ ...validPayload, to: "not-a-uuid" }, senderId, 1000),
    /valid recipient/i,
  );
});

test("rejects self-messaging even when UUID casing differs", () => {
  assert.match(
    validateMessage({ ...validPayload, to: senderId.toUpperCase() }, senderId, 1000),
    /yourself/i,
  );
});

test("rejects empty and oversized messages", () => {
  assert.match(
    validateMessage({ ...validPayload, text: " \n " }, senderId, 1000),
    /contain text/i,
  );
  assert.match(
    validateMessage({ ...validPayload, text: "12345" }, senderId, 4),
    /at most 4 characters/i,
  );
});

test("rejects invalid message limits", () => {
  for (const maxLength of [0, -1, 1.5, NaN, Infinity]) {
    assert.match(
      validateMessage(validPayload, senderId, maxLength),
      /at most/i,
    );
  }
});

test("rejects invalid client IDs", () => {
  for (const clientId of ["", "   ", "x".repeat(129), 42, null]) {
    assert.match(
      validateMessage({ ...validPayload, clientId }, senderId, 1000),
      /valid clientId/i,
    );
  }
});

test("accepts the maximum client ID length", () => {
  assert.equal(
    validateMessage({ ...validPayload, clientId: "x".repeat(128) }, senderId, 1000),
    null,
  );
});
