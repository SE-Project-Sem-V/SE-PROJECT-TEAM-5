
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPresenceTracker } = require("../sockets/presence");

function createMockIo() {
  const events = [];

  return {
    events,
    emit(event, payload) {
      events.push({ event, payload });
    },
  };
}

test("first connection marks a user online", () => {
  const io = createMockIo();
  const presence = createPresenceTracker(io);

  assert.equal(presence.addConnection("alice", "socket-1"), true);
  assert.equal(presence.isOnline("alice"), true);
  assert.deepEqual(presence.getOnlineUserIds(), ["alice"]);
  assert.deepEqual(io.events, [
    {
      event: "presenceUpdate",
      payload: { userId: "alice", online: true },
    },
  ]);
});

test("last disconnect marks a user offline", () => {
  const io = createMockIo();
  const presence = createPresenceTracker(io);

  presence.addConnection("alice", "socket-1");

  assert.equal(presence.removeConnection("alice", "socket-1"), true);
  assert.equal(presence.isOnline("alice"), false);
  assert.deepEqual(presence.getOnlineUserIds(), []);
  assert.deepEqual(io.events[1], {
    event: "presenceUpdate",
    payload: { userId: "alice", online: false },
  });
});

test("user stays online while another connection remains", () => {
  const io = createMockIo();
  const presence = createPresenceTracker(io);

  presence.addConnection("alice", "socket-1");
  presence.addConnection("alice", "socket-2");

  assert.equal(presence.removeConnection("alice", "socket-1"), false);
  assert.equal(presence.isOnline("alice"), true);
  assert.equal(io.events.length, 1);

  assert.equal(presence.removeConnection("alice", "socket-2"), true);
  assert.equal(presence.isOnline("alice"), false);
  assert.equal(io.events.length, 2);
});

test("duplicate connections and unknown disconnects do not corrupt presence", () => {
  const io = createMockIo();
  const presence = createPresenceTracker(io);

  assert.equal(presence.addConnection("alice", "socket-1"), true);
  assert.equal(presence.addConnection("alice", "socket-1"), false);

  assert.equal(presence.removeConnection("alice", "unknown-socket"), false);
  assert.equal(presence.isOnline("alice"), true);
  assert.equal(io.events.length, 1);

  assert.equal(presence.removeConnection("alice", "socket-1"), true);
  assert.equal(presence.removeConnection("alice", "socket-1"), false);
  assert.equal(io.events.length, 2);
});
