const jwt = require("jsonwebtoken");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unauthorized(res) {
  return res.set("WWW-Authenticate", "Bearer").status(401).json({
    status: "error", message: "Authentication required.",
  });
}

// HTTP authentication only. Socket.IO retains its existing verifier and policy.
function requireAuth({ pool, jwtSecret }) {
  return async function authenticate(req, res, next) {
    const authorizationCount = req.rawHeaders.filter((_, index) =>
      index % 2 === 0 && req.rawHeaders[index].toLowerCase() === "authorization").length;
    const match = /^Bearer[ \t]+(\S+)$/i.exec(req.get("Authorization") || "");
    if (authorizationCount !== 1 || !match) return unauthorized(res);

    let payload;
    try {
      // HS256 is jsonwebtoken's default signing algorithm used by this project.
      // verify also enforces exp/nbf when supplied; issuance belongs to CHATAPP-7.
      payload = jwt.verify(match[1], jwtSecret, { algorithms: ["HS256"] });
      if (!payload || typeof payload !== "object" ||
          typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)) {
        return unauthorized(res);
      }
    } catch {
      return unauthorized(res);
    }

    try {
      const { rows } = await pool.query("SELECT id FROM users WHERE id = $1::uuid", [payload.sub]);
      if (rows.length !== 1) return unauthorized(res);
      req.user = { id: rows[0].id };
      return next();
    } catch (error) {
      // CHATAPP-26's final handler logs only a fixed label/status, never raw errors.
      return next(error);
    }
  };
}

module.exports = { requireAuth };
