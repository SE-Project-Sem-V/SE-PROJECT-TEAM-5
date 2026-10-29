const { Router } = require("express");
const { requireAuth } = require("../middleware/require-auth");
const { withTransaction } = require("../db/pool");
const { createGroupRoom, listRoomMembers, RoomOperationError, roomOperationCode } = require("../db/rooms");
const { addGroupMembers } = require("../db/rooms");
const {
  AuthorizationError,
  requireActiveMember,
} = require("../services/room-authorization");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicMembers(members) {
  return members.map(({ id, username }) => ({ id, username }));
}

function groupFailure(res, status, message, code = "INVALID_INPUT") {
  res.locals?.logFailure?.("group.operation.failed", code, { status });
  return res.status(status).json({ status: "error", message });
}

function createRoomsRouter({ pool, jwtSecret }) {
  const router = Router();
  const authenticate = requireAuth({ pool, jwtSecret });

  router.use(authenticate);
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.name
         FROM chat_rooms AS r
         JOIN room_members AS rm ON rm.room_id = r.id
         WHERE r.kind = 'group'
           AND rm.user_id = $1::uuid
           AND rm.left_at IS NULL
         ORDER BY r.created_at DESC, r.id`,
        [req.user.id]
      );

      const rooms = await Promise.all(
        rows.map(async (room) => ({
          ...room,
          members: publicMembers(
            await listRoomMembers(pool, room.id)
          ),
        }))
      );

      return res.json({ rooms });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = req.body;

      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["name", "memberIds"].includes(key))
      ) {
        return groupFailure(res, 400, "Invalid group payload.");
      }

      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.trim().length > 100 ||
        /[\u0000-\u001f\u007f]/.test(body.name)
      ) {
        return groupFailure(res, 400, "Group name must contain 1–100 valid characters.");
      }

      const memberIds = body.memberIds ?? [];

      if (
        !Array.isArray(memberIds) ||
        memberIds.length < 1 ||
        memberIds.some(
          (id) => typeof id !== "string" || !UUID_PATTERN.test(id)
        )
      ) {
        return groupFailure(res, 400, "Select at least one valid member.");
      }

      const uniqueIds = [
        ...new Map(memberIds.map((id) => [id.toLowerCase(), id])).values(),
      ];

      if (uniqueIds.some((id) => id.toLowerCase() === req.user.id.toLowerCase())) {
        return groupFailure(res, 400, "The creator is included automatically.");
      }

      const room = await createGroupRoom(pool, {
        name: body.name.trim(),
        createdBy: req.user.id,
        memberIds: uniqueIds,
      });

      return res.status(201).json({
        room: {
          id: room.id,
          name: room.name,
          members: publicMembers(room.members),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:roomId/members", async (req, res, next) => {
    try {
      const { roomId } = req.params;

      if (!UUID_PATTERN.test(roomId)) {
        return groupFailure(res, 400, "Invalid room ID.");
      }

      const body = req.body;

      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "memberIds") ||
        !Array.isArray(body.memberIds) ||
        body.memberIds.length < 1 ||
        body.memberIds.some(
          (id) => typeof id !== "string" || !UUID_PATTERN.test(id),
        )
      ) {
        return groupFailure(res, 400, "Provide a non-empty list of valid member IDs.");
      }

      const memberIds = [
        ...new Map(
          body.memberIds.map((id) => [id.toLowerCase(), id])
        ).values()
      ];

      if (memberIds.some((id) => id.toLowerCase() === req.user.id.toLowerCase())) {
        return groupFailure(res, 400, "The creator is already a member.");
      }

      const members = await addGroupMembers(
        pool,
        roomId,
        memberIds,
        req.user.id
      );

      return res.json({
        members: publicMembers(members),
      });
    } catch (error) {
      if (roomOperationCode(error) === "ROOM_NOT_FOUND") {
        return groupFailure(res, 404, "Room not found.", "ROOM_NOT_FOUND");
      }

      if (roomOperationCode(error) === "ROOM_CREATOR_REQUIRED") {
        return groupFailure(res, 403, "Only the group creator can add members.", "ROOM_CREATOR_REQUIRED");
      }

      if (roomOperationCode(error) === "GROUP_ROOM_REQUIRED") {
        return groupFailure(res, 400, "Members can only be added to group rooms.", "GROUP_ROOM_REQUIRED");
      }

      if (roomOperationCode(error) === "MEMBER_REJOIN_REQUIRED") {
        return groupFailure(res, 409, "A departed member cannot be re-added by this operation.", "MEMBER_REJOIN_REQUIRED");
      }

      return next(error);
    }
  });

router.get("/:roomId/messages", async (req, res, next) => {
  try {
    const { roomId } = req.params;

    if (!UUID_PATTERN.test(roomId)) {
      return groupFailure(res, 400, "Invalid room ID.");
    }

    const messages = await withTransaction(pool, async (client) => {
      // Lock the group row to coordinate the authorization/read operation.
      const roomResult = await client.query(
        `SELECT id
         FROM chat_rooms
         WHERE id = $1::uuid
           AND kind = 'group'
         FOR UPDATE`,
        [roomId],
      );

      if (roomResult.rowCount !== 1) {
        throw new RoomOperationError("ROOM_NOT_FOUND");
      }

      // Verify active membership within the same transaction.
      const membershipResult = await client.query(
        `SELECT user_id
         FROM room_members
         WHERE room_id = $1
           AND user_id = $2::uuid
           AND left_at IS NULL
         FOR UPDATE`,
        [roomId, req.user.id],
      );

      if (membershipResult.rowCount !== 1) {
        throw new RoomOperationError("ROOM_ACCESS_DENIED");
      }

      const { rows } = await client.query(
        `SELECT id, sender_id, room_id, content, created_at
         FROM messages
         WHERE room_id = $1::uuid
         ORDER BY created_at ASC, id ASC`,
        [roomId],
      );

      return rows.map((message) => ({
        id: message.id,
        from: message.sender_id,
        roomId: message.room_id,
        content: message.content,
        timestamp: new Date(message.created_at).toISOString(),
      }));
    });

    return res.json({ messages });
  } catch (error) {
    if (roomOperationCode(error) === "ROOM_NOT_FOUND") {
      return groupFailure(res, 404, "Group room not found.", "ROOM_NOT_FOUND");
    }

    if (roomOperationCode(error) === "ROOM_ACCESS_DENIED") {
      return groupFailure(res, 403, "You do not have access to this group.", "ROOM_ACCESS_DENIED");
    }

    return next(error);
  }
});


  return router;
}

module.exports = { createRoomsRouter };
