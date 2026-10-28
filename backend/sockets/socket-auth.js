
const jwt = require("jsonwebtoken");

/**
 * Authenticates Socket.IO connections using a JWT supplied
 * in the Socket.IO handshake.
 */
function createSocketAuthMiddleware(jwtSecret) {
  return function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token) {
      return next(new Error("Authentication required"));
    }

    try {
      const payload = jwt.verify(token, jwtSecret);

      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.sub !== "string" ||
        !payload.sub
      ) {
        return next(new Error("Invalid token payload"));
      }

      socket.data.user = { id: payload.sub };
      return next();
    } catch {
      return next(new Error("Invalid or expired token"));
    }
  };
}

module.exports = { createSocketAuthMiddleware };
