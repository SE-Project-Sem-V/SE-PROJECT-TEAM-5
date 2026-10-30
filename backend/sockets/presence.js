
const { logFailure } = require("../logging");

function createPresenceTracker(io, logger = console) {
  const connections = new Map();

  function getOnlineUserIds() {
    return [...connections.keys()];
  }

  function isOnline(userId) {
    return (connections.get(userId)?.size ?? 0) > 0;
  }

  function emitPresence(userId, online) {
    try {
      io.emit("presenceUpdate", { userId, online });
    } catch {
      logFailure(logger, "presence.update.failed", "PRESENCE_UPDATE_FAILED", {
        operation: online ? "online" : "offline",
      });
    }
  }

  function addConnection(userId, socketId) {
    let userSockets = connections.get(userId);

    if (!userSockets) {
      userSockets = new Set();
      connections.set(userId, userSockets);
    }

    // A duplicate socket ID must not change presence.
    if (userSockets.has(socketId)) {
      return false;
    }

    const wasOffline = userSockets.size === 0;
    userSockets.add(socketId);

    if (wasOffline) {
      emitPresence(userId, true);
    }

    return wasOffline;
  }

  function removeConnection(userId, socketId) {
    const userSockets = connections.get(userId);

    // Ignore unknown sockets and duplicate disconnects.
    if (!userSockets || !userSockets.has(socketId)) {
      return false;
    }

    userSockets.delete(socketId);

    if (userSockets.size === 0) {
      connections.delete(userId);
      emitPresence(userId, false);
      return true;
    }

    return false;
  }

  return {
    addConnection,
    removeConnection,
    getOnlineUserIds,
    isOnline,
  };
}

module.exports = { createPresenceTracker };
