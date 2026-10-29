
const jwt = require("jsonwebtoken");
const { AppError, socketConnectionError } = require("../errors");

/**
 * Authenticates Socket.IO connections using a JWT supplied
 * in the Socket.IO handshake.
 */
function createSocketAuthMiddleware(jwtSecret) {
  return function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token) {
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
        return next(socketConnectionError(new AppError("AUTH_INVALID", "payload")));
      }

      socket.data.user = { id: payload.sub };
      return next();
    } catch (error) {
      const code = error instanceof jwt.TokenExpiredError ? "AUTH_EXPIRED" : "AUTH_INVALID";
      return next(socketConnectionError(new AppError(code, "socket")));
    }
  };
}

module.exports = { createSocketAuthMiddleware };
