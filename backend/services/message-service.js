
const { withTransaction } = require("../db/pool");

const { AppError } = require("../errors");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MESSAGE_FIELDS = new Set(["to", "text", "clientId"]);
const GROUP_MESSAGE_FIELDS = new Set(["roomId", "text", "clientId"]);

function validateTextAndClientId(text, clientId, maxLength) {
  if (
    !Number.isSafeInteger(maxLength) ||
    maxLength < 1 ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > maxLength
  ) {
    return `Message must contain text and be at most ${maxLength} characters.`;
  }

  if (
    typeof clientId !== "string" ||
    !clientId.trim() ||
    clientId.length > 128
  ) {
    return "A valid clientId is required.";
  }

  return null;
}

function validateMessage(payload, senderId, maxLength) {
  if (typeof senderId !== "string" || !UUID_PATTERN.test(senderId)) {
    return "This account cannot send database messages.";
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return "Invalid message payload.";
  }

  const keys = Object.keys(payload);

  if (
    keys.some((key) => !MESSAGE_FIELDS.has(key)) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    return "Invalid message payload.";
  }

  const { to, text, clientId } = payload;

  if (typeof to !== "string" || !UUID_PATTERN.test(to)) {
    return "A valid recipient is required.";
  }

  if (to.toLowerCase() === senderId.toLowerCase()) {
    return "You cannot send a direct message to yourself.";
  }

  return validateTextAndClientId(text, clientId, maxLength);
}

function validateGroupMessage(payload, senderId, maxLength) {
  if (typeof senderId !== "string" || !UUID_PATTERN.test(senderId)) {
    return "This account cannot send database messages.";
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return "Invalid group message payload.";
  }

  if (
    Object.getPrototypeOf(payload) !== Object.prototype ||
    Object.keys(payload).some(
      (key) => !GROUP_MESSAGE_FIELDS.has(key),
    )
  ) {
    return "Invalid group message payload.";
  }

  if (
    typeof payload.roomId !== "string" ||
    !UUID_PATTERN.test(payload.roomId)
  ) {
    return "A valid group roomId is required.";
  }

  return validateTextAndClientId(
    payload.text,
    payload.clientId,
    maxLength,
  );
}

async function saveDirectMessage(
  pool,
  senderId,
  recipientId,
  text,
  clientId,
) {
  return withTransaction(pool, async (client) => {
    const roomResult = await client.query(
      `SELECT id
       FROM chat_rooms
       WHERE kind = 'direct'
         AND direct_user_low = LEAST($1::uuid, $2::uuid)
         AND direct_user_high = GREATEST($1::uuid, $2::uuid)`,
      [senderId, recipientId],
    );

    if (roomResult.rowCount !== 1) {
      throw new AppError("CONVERSATION_NOT_FOUND");
    }

    const roomId = roomResult.rows[0].id;

    const membershipResult = await client.query(
      `SELECT user_id, left_at
       FROM room_members
       WHERE room_id = $1
         AND user_id = ANY($2::uuid[])
       ORDER BY user_id
       FOR UPDATE`,
      [roomId, [senderId, recipientId]],
    );

    if (
      membershipResult.rowCount !== 2 ||
      membershipResult.rows.some((member) => member.left_at !== null)
    ) {
      throw new AppError("ROOM_FORBIDDEN");
    }

    const insertResult = await client.query(
      `INSERT INTO messages (room_id, sender_id, content, client_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sender_id, client_id) DO NOTHING
       RETURNING id, room_id, sender_id, content, created_at`,
      [roomId, senderId, text, clientId],
    );

    let row = insertResult.rows[0];
    const created = Boolean(row);

    if (!row) {
      const existingResult = await client.query(
        `SELECT id, room_id, sender_id, content, created_at
         FROM messages
         WHERE sender_id = $1 AND client_id = $2`,
        [senderId, clientId],
      );

      row = existingResult.rows[0];

      if (!row || row.room_id !== roomId || row.content !== text) {
        throw new AppError("CLIENT_ID_CONFLICT");
      }
    }

    return {
      id: row.id,
      roomId: row.room_id,
      userId: row.sender_id,
      to: recipientId,
      text: row.content,
      timestamp: new Date(row.created_at).toISOString(),
    };
  });
}

async function saveGroupMessage(
  pool,
  senderId,
  roomId,
  text,
  clientId,
) {
  return withTransaction(pool, async (client) => {
    // Serialize group-message writes against operations that lock the room.
    const roomResult = await client.query(
      `SELECT id
       FROM chat_rooms
       WHERE id = $1::uuid
         AND kind = 'group'
       FOR UPDATE`,
      [roomId],
    );

    if (roomResult.rowCount !== 1) {
      throw new Error("GROUP_ROOM_NOT_FOUND");
    }

    // Require active membership while the transaction holds the row lock.
    const membershipResult = await client.query(
      `SELECT user_id
       FROM room_members
       WHERE room_id = $1
         AND user_id = $2
         AND left_at IS NULL
       FOR UPDATE`,
      [roomId, senderId],
    );

    if (membershipResult.rowCount !== 1) {
      throw new Error("ROOM_ACCESS_DENIED");
    }

    const insertResult = await client.query(
      `INSERT INTO messages (room_id, sender_id, content, client_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sender_id, client_id) DO NOTHING
       RETURNING id, room_id, sender_id, content, created_at`,
      [roomId, senderId, text, clientId],
    );

    let row = insertResult.rows[0];
    const created = Boolean(row);

    if (!row) {
      const existingResult = await client.query(
        `SELECT id, room_id, sender_id, content, created_at
         FROM messages
         WHERE sender_id = $1 AND client_id = $2`,
        [senderId, clientId],
      );

      row = existingResult.rows[0];

      if (
        !row ||
        row.room_id !== roomId ||
        row.content !== text
      ) {
        throw new Error("CLIENT_ID_REUSED");
      }
    }

    // Capture active recipients within this transaction.
    const recipientsResult = await client.query(
      `SELECT user_id
       FROM room_members
       WHERE room_id = $1
         AND left_at IS NULL
       ORDER BY user_id`,
      [roomId],
    );

    return {
      message: {
        id: row.id,
        roomId: row.room_id,
        userId: row.sender_id,
        text: row.content,
        timestamp: new Date(row.created_at).toISOString(),
      },
      created,
      recipientIds: recipientsResult.rows
        .map((member) => member.user_id)
        .filter(
          (userId) =>
            userId.toLowerCase() !== senderId.toLowerCase(),
        ),
    };
  });
}

module.exports = {
  validateMessage,
  saveDirectMessage,
  validateGroupMessage,
  saveGroupMessage,
};
