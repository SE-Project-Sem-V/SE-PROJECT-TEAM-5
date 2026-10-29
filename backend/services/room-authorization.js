const { isActiveMember } = require("../db/rooms");

class AuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

async function requireActiveMember(db, roomId, userId) {
  const active = await isActiveMember(db, roomId, userId);

  if (!active) {
    throw new AuthorizationError("ROOM_ACCESS_DENIED");
  }

  return true;
}

async function requireRoomCreator(db, roomId, userId) {
  const { rows } = await db.query(
    `SELECT created_by
     FROM chat_rooms
     WHERE id = $1::uuid`,
    [roomId]
  );

  if (rows.length !== 1) {
    throw new AuthorizationError("ROOM_NOT_FOUND");
  }

  if (rows[0].created_by.toLowerCase() !== userId.toLowerCase()) {
    throw new AuthorizationError("ROOM_CREATOR_REQUIRED");
  }

  return true;
}

module.exports = {
  AuthorizationError,
  requireActiveMember,
  requireRoomCreator,
};
