const { Router } = require("express");
const { requireAuth } = require("../middleware/require-auth");
const { withTransaction } = require("../db/pool");
const { AppError, sendHttpError } = require("../errors");
const { assertActiveSession } = require("../services/session-service");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicProfile({ id, username, display_name, status_message }) {
  return { id, username, display_name, status_message };
}

function validProfileText(value, max) {
  // PostgreSQL counts Unicode characters, not UTF-16 code units. Reject NUL
  // and unpaired surrogates rather than letting the driver replace the input.
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0") &&
    Array.from(value).length <= max;
}

function searchQuery(originalUrl) {
  const raw = originalUrl.slice(originalUrl.indexOf("?") + 1);

  try {
    const queryString = originalUrl.includes("?") ? raw : "";
    decodeURIComponent(queryString.replace(/\+/g, " "));
    const params = new URLSearchParams(queryString);

    if (
      [...params.keys()].some((key) => key !== "q") ||
      params.getAll("q").length > 1
    ) {
      return null;
    }

    const query = (params.get("q") || "").trim();

    if (
      query.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(query)
    ) {
      return null;
    }

    return query;
  } catch {
    return null;
  }
}

function createUsersRouter({ pool, jwtSecret }) {
  const router = Router();
  const authenticate = requireAuth({ pool, jwtSecret });

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/me", authenticate, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT id, username, display_name, status_message FROM users WHERE id = $1::uuid",
        [req.user.id],
      );
      if (!rows[0]) throw new AppError("AUTH_INVALID", "http");
      res.json({ user: publicProfile(rows[0]) });
    } catch (error) { next(error); }
  });

  router.patch("/me", authenticate, async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length === 0 ||
          Object.keys(body).some(key => !["displayName", "statusMessage"].includes(key))) {
        throw new AppError("INVALID_INPUT");
      }
      const namePresent = Object.hasOwn(body, "displayName");
      const statusPresent = Object.hasOwn(body, "statusMessage");
      // trim() omits Unicode NEXT LINE (U+0085), which PostgreSQL treats as space.
      if ((namePresent && (!validProfileText(body.displayName, 64) || !/[^\p{White_Space}\uFEFF]/u.test(body.displayName))) ||
          (statusPresent && body.statusMessage !== null && !validProfileText(body.statusMessage, 280))) {
        throw new AppError("INVALID_INPUT");
      }
      const user = await withTransaction(pool, async client => {
        // Same lock order as message writes: logout must commit before later
        // writes can be admitted, or wait for an already-authorized update.
        await assertActiveSession(client, req.session, true);
        const { rows } = await client.query(
          `UPDATE users SET
             display_name = CASE WHEN $2::boolean THEN $3::text ELSE display_name END,
             status_message = CASE WHEN $4::boolean THEN $5::text ELSE status_message END
           WHERE id = $1::uuid
           RETURNING id, username, display_name, status_message`,
          [req.user.id, namePresent, namePresent ? body.displayName : null, statusPresent,
            statusPresent && body.statusMessage !== "" ? body.statusMessage : null],
        );
        if (!rows[0]) throw new AppError("AUTH_INVALID", "http");
        return publicProfile(rows[0]);
      });
      res.json({ user });
    } catch (error) { next(error); }
  });

  // CHATAPP-10: authenticated user search.
  router.get("/", authenticate, async (req, res, next) => {
    try {
      const query = searchQuery(req.originalUrl);

      if (query === null) {
        return sendHttpError(res, new AppError("INVALID_INPUT", "search"));
      }

      if (!query) {
        return res.json({ users: [] });
      }

      const pattern = `%${query.replace(/[!%_]/g, "!$&")}%`;

      const { rows } = await pool.query(
        `SELECT id, username, display_name, status_message
         FROM users
         WHERE id <> $1::uuid
           AND username COLLATE "C" ILIKE $2 ESCAPE '!'
         ORDER BY lower(username COLLATE "C"), id
         LIMIT $3`,
        [req.user.id, pattern, 20],
      );

      return res.json({
        users: rows.map(publicProfile),
      });
    } catch (error) {
      return next(error);
    }
  });

  // CHATAPP-11: create or retrieve a direct conversation.
  router.post(
    "/:userId/conversation",
    authenticate,
    async (req, res, next) => {
      try {
        const senderId = req.user.id;
        const recipientId = req.params.userId;

        if (!UUID_PATTERN.test(recipientId)) {
          return sendHttpError(res, new AppError("INVALID_INPUT", "recipient"));
        }

        if (
          recipientId.toLowerCase() === senderId.toLowerCase()
        ) {
          return sendHttpError(res, new AppError("INVALID_INPUT", "selfConversation"));
        }

        const conversation = await withTransaction(
          pool,
          async (client) => {
            const { rowCount } = await client.query(
              "SELECT id FROM users WHERE id = $1::uuid",
              [recipientId],
            );

            if (rowCount !== 1) {
              throw new AppError("RECIPIENT_NOT_FOUND");
            }

            const [low, high] = [senderId, recipientId].sort(
              (a, b) =>
                a.toLowerCase().localeCompare(b.toLowerCase()),
            );

            const {
              rows: [room],
            } = await client.query(
              `INSERT INTO chat_rooms
                 (kind, created_by, direct_user_low, direct_user_high)
               VALUES ('direct', $1::uuid, $2::uuid, $3::uuid)
               ON CONFLICT (direct_user_low, direct_user_high)
               DO UPDATE
                 SET direct_user_low = EXCLUDED.direct_user_low
               RETURNING id`,
              [low, low, high],
            );

            await client.query(
              `INSERT INTO room_members (room_id, user_id)
               VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)
               ON CONFLICT (room_id, user_id)
               DO UPDATE SET left_at = NULL`,
              [room.id, senderId, recipientId],
            );

            return { id: room.id };
          },
        );

        return res.status(200).json({ conversation });
      } catch (error) {
        return next(error);
      }
    },
  );

  // CHATAPP-11: load saved messages for a direct conversation.
  router.get(
    "/:userId/messages",
    authenticate,
    async (req, res, next) => {
      try {
        const currentUserId = req.user.id;
        const recipientId = req.params.userId;

        if (!UUID_PATTERN.test(recipientId)) {
          return sendHttpError(res, new AppError("INVALID_INPUT", "recipient"));
        }

        if (
          recipientId.toLowerCase() === currentUserId.toLowerCase()
        ) {
          return sendHttpError(res, new AppError("INVALID_INPUT", "selfHistory"));
        }

        const { rows } = await pool.query(
          `SELECT m.id, m.sender_id, m.content, m.created_at
           FROM messages AS m
           JOIN chat_rooms AS r ON r.id = m.room_id
           WHERE r.kind = 'direct'
             AND r.direct_user_low =
                 LEAST($1::uuid, $2::uuid)
             AND r.direct_user_high =
                 GREATEST($1::uuid, $2::uuid)
             AND EXISTS (
               SELECT 1
               FROM room_members AS mine
               WHERE mine.room_id = r.id
                 AND mine.user_id = $1::uuid
                 AND mine.left_at IS NULL
             )
             AND EXISTS (
               SELECT 1
               FROM room_members AS theirs
               WHERE theirs.room_id = r.id
                 AND theirs.user_id = $2::uuid
                 AND theirs.left_at IS NULL
             )
           ORDER BY m.created_at ASC, m.id ASC`,
          [currentUserId, recipientId],
        );

        return res.json({
          messages: rows.map((row) => ({
            id: row.id,
            from: row.sender_id,
            to:
              row.sender_id.toLowerCase() ===
              currentUserId.toLowerCase()
                ? recipientId
                : currentUserId,
            content: row.content,
            timestamp: new Date(row.created_at).toISOString(),
            state: "sent",
          })),
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  return router;
}

module.exports = { createUsersRouter };
