
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const { createPresenceTracker } = require("../sockets/presence");

function createMockIo() {
  const listeners = new Map();
  const broadcasts = [];

  return {
    broadcasts,

    emit(event, payload) {
      broadcasts.push({ event, payload });
    },

    on(event, listener) {
      listeners.set(event, listener);
    },

    connect(socket) {
      listeners.get("connection")(socket);
    },
  };
}

function createMockSocket(userId, socketId) {
  const handlers = new Map();
  const outgoing = [];

  return {
    id: socketId,
    data: { user: { id: userId } },
    handlers,
    outgoing,

    emit(event, payload) {
      outgoing.push({ event, payload });
    },

    on(event, handler) {
      handlers.set(event, handler);
    },

    join() {},

    disconnect(reason = "client disconnect") {
      handlers.get("disconnect")?.(reason);
    },
  };
}

test("presence tracker emits online and offline transitions for connections", () => {
  const io = createMockIo();
  const presence = createPresenceTracker(io);

  // Two sockets represent the same user logged in twice.
  presence.addConnection("alice", "socket-1");
  presence.addConnection("alice", "socket-2");

  assert.equal(presence.isOnline("alice"), true);
  assert.deepEqual(io.broadcasts, [
    {
      event: "presenceUpdate",
      payload: { userId: "alice", online: true },
    },
  ]);

  // First disconnect does not make Alice offline.
  presence.removeConnection("alice", "socket-1");
  assert.equal(presence.isOnline("alice"), true);
  assert.equal(io.broadcasts.length, 1);

  // Final disconnect marks Alice offline.
  presence.removeConnection("alice", "socket-2");
  assert.equal(presence.isOnline("alice"), false);
  assert.deepEqual(io.broadcasts[1], {
    event: "presenceUpdate",
    payload: { userId: "alice", online: false },
  });
});

test("presence snapshot contains users who are already online", () => {
  const io = createMockIo();
  const presence = createPresenceTracker(io);

  presence.addConnection("alice", "socket-alice");
  presence.addConnection("bob", "socket-bob");

  const snapshot = presence.getOnlineUserIds().sort();

  assert.deepEqual(snapshot, ["alice", "bob"]);
});