const { AppError, normalizeError, sendHttpError } = require("../errors");
const { authenticateSession } = require("../services/session-service");

function unauthorized(res, code = "AUTH_INVALID") {
  res.set("WWW-Authenticate", "Bearer");
  return sendHttpError(res, new AppError(code, "http"));
}

// HTTP and Socket.IO share signature, ownership and durable session verification.
function requireAuth({ pool, jwtSecret }) {
  return async function authenticate(req, res, next) {
    const authorizationCount = req.rawHeaders.filter((_, index) =>
      index % 2 === 0 && req.rawHeaders[index].toLowerCase() === "authorization").length;
    const match = /^Bearer[ \t]+(\S+)$/i.exec(req.get("Authorization") || "");
    if (authorizationCount === 0) return unauthorized(res, "AUTH_REQUIRED");
    if (authorizationCount !== 1 || !match) return unauthorized(res);

    try {
      req.session = await authenticateSession(pool, match[1], jwtSecret);
      req.user = { id: req.session.userId };
      return next();
    } catch (error) {
      const { code } = normalizeError(error);
      if (code.startsWith("AUTH_")) return unauthorized(res, code);
      return next(error);
    }
  };
}

module.exports = { requireAuth };
