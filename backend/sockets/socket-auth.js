
const { AppError, normalizeError, socketConnectionError } = require("../errors");
const { authenticateSession } = require("../services/session-service");
const { logFailure } = require("../logging");

/**
 * Authenticates Socket.IO connections using a JWT supplied
 * in the Socket.IO handshake.
 */
function createSocketAuthMiddleware({ pool, jwtSecret, logger = console, onAuthenticated }) {
  return async function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token) {
      logFailure(logger, "auth.socket.failed", "AUTH_REQUIRED");
      return next(socketConnectionError(new AppError("AUTH_REQUIRED", "socket")));
    }

    try {
      socket.data.session = await authenticateSession(pool, token, jwtSecret);
      socket.data.user = { id: socket.data.session.userId };
      if (onAuthenticated && !await onAuthenticated(socket)) {
        throw socket.data.sessionFailure || new AppError("AUTH_INVALID");
      }
      return next();
    } catch (error) {
      const { code, message } = normalizeError(error);
      logFailure(logger, "auth.socket.failed", code);
      const variant = code === "AUTH_INVALID" && message === "Invalid token payload" ? "payload" : "socket";
      return next(socketConnectionError(new AppError(code, variant)));
    }
  };
}

module.exports = { createSocketAuthMiddleware };
