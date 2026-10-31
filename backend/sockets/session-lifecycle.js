const { assertActiveSession } = require("../services/session-service");
const { AppError, normalizeError } = require("../errors");
const { logFailure } = require("../logging");
const cleanups = new WeakMap();

function endSessionSocket(socket, error, logger = console) {
  socket.data.sessionEnded = true;
  const { code, message } = normalizeError(error);
  socket.data.sessionFailure = new AppError(code);
  try { socket.emit("auth:session-ended", { code, message }); } catch {
    logFailure(logger, "session.disconnect.failed", "INTERNAL_ERROR");
  }
  try {
    if (socket.connected) socket.disconnect(true);
    else if (socket.conn?.readyState !== "closed") {
      // Socket.IO disconnect() is a no-op before namespace connection.
      // Discard pending Engine.IO traffic so a late next() cannot connect it.
      socket.conn.close(true);
    }
    if (socket.connected || (socket.conn && !["closed", "closing"].includes(socket.conn.readyState))) {
      throw new Error("Session transport did not close");
    }
    cleanups.get(socket)?.();
    return true;
  } catch {
    logFailure(logger, "session.disconnect.failed", "INTERNAL_ERROR");
    return false;
  }
}

function createSessionLifecycle(pool, logger = console) {
  const sockets = new Map();
  async function track(socket) {
    const id = socket.data.session.id;
    const group = sockets.get(id) || new Set();
    sockets.set(id, group);
    group.add(socket);
    let timer;
    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      group.delete(socket);
      if (!group.size) sockets.delete(id);
      socket.off("disconnect", cleanup);
      socket.conn?.off("close", cleanup);
      cleanups.delete(socket);
    }
    cleanups.set(socket, cleanup);
    socket.once("disconnect", cleanup);
    // Pending namespace connections do not emit disconnect if the client leaves.
    socket.conn?.once("close", cleanup);
    try {
      // Register first, then recheck: logout cannot miss a connection in flight.
      const session = await assertActiveSession(pool, socket.data.session);
      if (cleaned || socket.conn?.readyState === "closed" || socket.data.sessionEnded) { cleanup(); return false; }
      timer = setTimeout(() => endSessionSocket(socket, new AppError("AUTH_EXPIRED"), logger),
        Math.max(0, Math.min(session.expiresAt - Date.now(), 2147483647)));
      timer.unref?.();
      return true;
    } catch (error) {
      logFailure(logger, "session.check.failed", normalizeError(error).code);
      endSessionSocket(socket, error, logger);
      cleanup();
      return false;
    }
  }
  function disconnectSession(id) {
    let successful = true;
    for (const socket of [...(sockets.get(id) || [])]) {
      if (!endSessionSocket(socket, new AppError("AUTH_REVOKED"), logger)) successful = false;
    }
    return successful;
  }
  return { track, disconnectSession };
}

module.exports = { createSessionLifecycle, endSessionSocket };
