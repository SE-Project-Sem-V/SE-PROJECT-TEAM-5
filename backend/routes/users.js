const { Router } = require("express");
const { requireAuth } = require("../middleware/require-auth");

function searchQuery(originalUrl) {
  const raw = originalUrl.slice(originalUrl.indexOf("?") + 1);
  try {
    // URLSearchParams alone tolerates invalid percent escapes/UTF-8. Reject them
    // explicitly, and inspect every parameter rather than a parser's first N.
    const queryString = originalUrl.includes("?") ? raw : "";
    decodeURIComponent(queryString.replace(/\+/g, " "));
    const params = new URLSearchParams(queryString);
    if ([...params.keys()].some((key) => key !== "q") || params.getAll("q").length > 1) return null;
    const query = (params.get("q") || "").trim();
    if (query.length > 64 || /[\u0000-\u001f\u007f]/.test(query)) return null;
    return query;
  } catch {
    return null;
  }
}

function createUsersRouter({ pool, jwtSecret }) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/", requireAuth({ pool, jwtSecret }), async (req, res) => {
    const query = searchQuery(req.originalUrl);
    if (query === null) {
      return res.status(400).json({
        status: "error", message: "Use a single q parameter of at most 64 characters without control characters.",
      });
    }
    if (!query) return res.json({ users: [] });

    // Escape the explicit LIKE escape character as well as both wildcards.
    // Backslashes are literal because this query uses ! as its escape character.
    const pattern = `%${query.replace(/[!%_]/g, "!$&")}%`;
    const { rows } = await pool.query(
      `SELECT id, username FROM users
       WHERE id <> $1::uuid AND username COLLATE "C" ILIKE $2 ESCAPE '!'
       ORDER BY lower(username COLLATE "C"), id
       LIMIT $3`,
      [req.user.id, pattern, 20],
    );
    // Keep the projection explicit even if the query gains columns in the future.
    return res.json({ users: rows.map(({ id, username }) => ({ id, username })) });
  });
  return router;
}

module.exports = { createUsersRouter };
