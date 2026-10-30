
const jwt = require("jsonwebtoken");
const { AppError, socketConnectionError } = require("../errors");
const { logFailure } = require("../logging");

/**
 * Authenticates Socket.IO connections using a JWT supplied
 * in the Socket.IO handshake.
 */
function createSocketAuthMiddleware(jwtSecret, logger = console) {
  return function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token) {
      logFailure(logger, "auth.socket.failed", "AUTH_REQUIRED");
      return next(socketConnectionError(new AppError("AUTH_REQUIRED", "socket")));
    }

    try {
      const payload = jwt.verify(token, jwtSecret);

      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.sub !== "string" ||
        !payload.sub
      ) {
        logFailure(logger, "auth.socket.failed", "AUTH_INVALID");
        return next(socketConnectionError(new AppError("AUTH_INVALID", "payload")));
      }

      socket.data.user = { id: payload.sub };
      return next();
    } catch (error) {
      const code = error instanceof jwt.TokenExpiredError ? "AUTH_EXPIRED" : "AUTH_INVALID";
      logFailure(logger, "auth.socket.failed", code);
      return next(socketConnectionError(new AppError(code, "socket")));
    }
  };
}

module.exports = { createSocketAuthMiddleware };
