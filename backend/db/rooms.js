const { withTransaction } = require("./pool");

const trustedRoomErrors = new WeakMap();
const ROOM_CODES = new Set([
  "MEMBER_REJOIN_REQUIRED", "ROOM_NOT_FOUND", "GROUP_ROOM_REQUIRED",
  "ROOM_CREATOR_REQUIRED", "ROOM_ACCESS_DENIED",
]);

class RoomOperationError extends Error {
  constructor(code) {
    const trustedCode = ROOM_CODES.has(code) ? code : "ROOM_OPERATION_FAILED";
    super(trustedCode);
    this.name = "RoomOperationError";
    this.code = trustedCode;
    trustedRoomErrors.set(this, trustedCode);
  }
}

function roomOperationCode(error) {
  return trustedRoomErrors.get(error);
}

function checkMemberIds(memberIds) {
  if (!Array.isArray(memberIds) || memberIds.some((id) => typeof id !== "string")) {
    throw new TypeError("memberIds must be an array of UUID strings.");
  }
}

// Internal primitive: the caller owns the transaction and has locked the room.
async function insertGroupMembers(client, roomId, memberIds) {
  const { rows } = await client.query(
    `SELECT user_id, left_at FROM room_members
     WHERE room_id = $1 AND user_id = ANY($2::uuid[])
     ORDER BY user_id FOR UPDATE`,
    [roomId, memberIds],
  );
  if (rows.some((member) => member.left_at !== null)) {
    throw new RoomOperationError("MEMBER_REJOIN_REQUIRED");
  }

  // Grouping operates on UUIDs, so differently cased UUID strings also deduplicate.
  // Never update left_at or joined_at on an existing membership.
  await client.query(
    `INSERT INTO room_members (room_id, user_id)
     SELECT $1, user_id FROM unnest($2::uuid[]) AS members(user_id)
     GROUP BY user_id ORDER BY user_id
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [roomId, memberIds],
  );
}

// Trusted database operation, not an authorization boundary. The service must
// supply the authenticated creator and decide who may create/invite before use.
async function createGroupRoom(pool, { name, createdBy, memberIds = [] }) {
  if (typeof name !== "string" || typeof createdBy !== "string") {
    throw new TypeError("name and createdBy must be strings.");
  }
  checkMemberIds(memberIds);
  return withTransaction(pool, async (client) => {
    const { rows: [room] } = await client.query(
      `INSERT INTO chat_rooms (kind, name, created_by)
       VALUES ('group', $1, $2)
       RETURNING id, kind, name, created_by, created_at`,
      [name, createdBy],
    );
    await insertGroupMembers(client, room.id, [createdBy, ...memberIds]);
    return { ...room, members: await listRoomMembers(client, room.id) };
  });
}


async function addGroupMembers(pool, roomId, memberIds, actorId) {
  checkMemberIds(memberIds);

  if (typeof actorId !== "string") {
    throw new TypeError("actorId must be the authenticated user's UUID.");
  }

  return withTransaction(pool, async (client) => {
    // Lock the room before checking ownership or changing membership.
    const { rows: [room] } = await client.query(
      `SELECT kind, created_by
       FROM chat_rooms
       WHERE id = $1
       FOR UPDATE`,
      [roomId],
    );

    if (!room) {
      throw new RoomOperationError("ROOM_NOT_FOUND");
    }

    // Direct-room membership remains managed by the existing pair workflow.
    if (room.kind !== "group") {
      throw new RoomOperationError("GROUP_ROOM_REQUIRED");
    }

    // Only the authenticated creator may add members.
    if (room.created_by.toLowerCase() !== actorId.toLowerCase()) {
      throw new RoomOperationError("ROOM_CREATOR_REQUIRED");
    }

    await insertGroupMembers(client, roomId, memberIds);

    return listRoomMembers(client, roomId);
  });
}


// Read helpers accept either the shared pool or a transaction client. This is a
// point-in-time check; sending/leaving services must coordinate membership locks.
async function isActiveMember(db, roomId, userId) {
  const { rows: [row] } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM room_members
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
     ) AS active`,
    [roomId, userId],
  );
  return row.active;
}

async function listRoomMembers(db, roomId, { includeDeparted = false } = {}) {
  if (typeof includeDeparted !== "boolean") {
    throw new TypeError("includeDeparted must be a boolean.");
  }
  const { rows } = await db.query(
    `SELECT u.id, u.username, rm.joined_at, rm.left_at
     FROM room_members AS rm JOIN users AS u ON u.id = rm.user_id
     WHERE rm.room_id = $1 AND ($2::boolean OR rm.left_at IS NULL)
     ORDER BY lower(u.username COLLATE "C"), u.id`,
    [roomId, includeDeparted],
  );
  return rows;
}

module.exports = {
  RoomOperationError, roomOperationCode, createGroupRoom, addGroupMembers, isActiveMember, listRoomMembers,
};
