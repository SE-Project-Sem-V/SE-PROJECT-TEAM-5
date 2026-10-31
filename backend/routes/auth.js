
const express = require("express");
const { randomUUID } = require("node:crypto");
const { AppError, normalizeError, sendHttpError } = require("../errors");
const { withTransaction } = require("../db/pool");
const { issueSession, revokeSession } = require("../services/session-service");
const { requireAuth } = require("../middleware/require-auth");
const {
  hashPassword,
  verifyPassword,
  PasswordInputError,
} = require("../security/passwords");

function createAuthRouter({ pool, jwtSecret, onLogout }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.post("/register", async (req, res, next) => {
    try {
      const { username, password, displayName } = req.body ?? {};

      if (
        typeof username !== "string" ||
        username.trim().length < 3 ||
        username.trim().length > 64 ||
        typeof password !== "string" ||
        typeof displayName !== "string" ||
        !displayName.trim() ||
        displayName.trim().length > 100
      ) {
        return sendHttpError(res, new AppError("INVALID_INPUT", "registration"));
      }

      const normalizedUsername = username.trim();

      let passwordHash;
      try {
        passwordHash = await hashPassword(password);
      } catch (error) {
        if (error instanceof PasswordInputError) {
          return sendHttpError(res, new AppError("INVALID_INPUT", "password"));
        }
        throw error;
      }

      const id = randomUUID();
      const { user, token } = await withTransaction(pool, async client => {
        const result = await client.query(
          `INSERT INTO users (id, username, password_hash, display_name)
           VALUES ($1, $2, $3, $4)
           RETURNING id, username, display_name`,
          [id, normalizedUsername, passwordHash, displayName.trim()],
        );
        const user = result.rows[0];
        const token = await issueSession(client, user.id, jwtSecret);
        return { user, token };
      });

      return res.status(201).json({
        status: "success",
        token,
        user,
      });
    } catch (error) {
      if (error.code === "23505") {
        return sendHttpError(res, new AppError("USERNAME_TAKEN"));
      }
      next(error);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};

      if (
        typeof username !== "string" ||
        !username.trim() ||
        typeof password !== "string" ||
        !password
      ) {
        return sendHttpError(res, new AppError("INVALID_INPUT", "login"));
      }

      const result = await pool.query(
        `SELECT id, username, display_name, password_hash
         FROM users
         WHERE lower(username COLLATE "C") = lower($1 COLLATE "C")
         LIMIT 1`,
        [username.trim()],
      );

      const user = result.rows[0];
      const valid = user
        ? await verifyPassword(password, user.password_hash)
        : false;

      if (!valid) {
        return sendHttpError(res, new AppError("INVALID_CREDENTIALS"));
      }

      const token = await issueSession(pool, user.id, jwtSecret);

      return res.status(200).json({
        status: "success",
        token,
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", requireAuth({ pool, jwtSecret }), async (req, res, next) => {
    try {
      await revokeSession(pool, req.session);
      if (!onLogout(req.session.id)) throw new AppError("INTERNAL_ERROR");
      return res.status(200).json({ status: "success" });
    } catch (error) {
      res.locals?.logFailure?.("session.logout.failed", normalizeError(error).code);
      return next(error);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
