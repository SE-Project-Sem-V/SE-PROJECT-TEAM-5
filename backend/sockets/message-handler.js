
const { formatDatabaseError } = require("../db/config");
const {
  validateMessage,
  saveDirectMessage,
  validateGroupMessage,
  saveGroupMessage,
} = require("../services/message-service");

function acknowledgeError(callback, message) {
  if (typeof callback === "function") {
    callback({ ok: false, error: message });
  }
}

function registerMessageHandlers({
  io,
  socket,
  pool,
  maxMessageLength,
  logger = console,
}) {
  const senderId = socket.data.user.id;

  logger.log("Authenticated client connected:", senderId);
  socket.join(`user:${senderId}`);

  socket.on("protected:ping", (callback) => {
    if (typeof callback !== "function") return;

    callback({
      status: "success",
      message: "pong",
      userId: senderId,
    });
  });

  socket.on("sendMessage", async (payload, callback) => {
    if (typeof callback !== "function") return;

    // Group payloads have roomId; direct payloads have to.
    const isGroupMessage =
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.prototype.hasOwnProperty.call(payload, "roomId");

    const validationError = isGroupMessage
      ? validateGroupMessage(payload, senderId, maxMessageLength)
      : validateMessage(payload, senderId, maxMessageLength);

    if (validationError) {
      return acknowledgeError(callback, validationError);
    }

    try {
      if (isGroupMessage) {
        const result = await saveGroupMessage(
          pool,
          senderId,
          payload.roomId,
          payload.text,
          payload.clientId,
        );

        callback({ ok: true, message: result.message });

        // Only active group members are selected for delivery.
        for (const memberId of result.recipientIds) {
          io.to(`user:${memberId}`).emit("newMessage", result.message);
        }

        return;
      }

      const message = await saveDirectMessage(
        pool,
        senderId,
        payload.to,
        payload.text,
        payload.clientId,
      );

      callback({ ok: true, message });

      io.to(`user:${message.to}`).emit("newMessage", message);
    } catch (error) {
      const knownErrors = {
        DIRECT_ROOM_NOT_FOUND:
          "No direct conversation exists with this recipient.",
        ACTIVE_MEMBERSHIP_REQUIRED:
          "Both users must be active members of the conversation.",
        GROUP_ROOM_NOT_FOUND:
          "The group conversation does not exist.",
        ROOM_ACCESS_DENIED:
          "You must be an active member of this group to send messages.",
        CLIENT_ID_REUSED:
          "This clientId was already used for a different message.",
      };

      if (knownErrors[error.message]) {
        return acknowledgeError(callback, knownErrors[error.message]);
      }

      logger.error(
        "[messages] Failed to save message:",
        formatDatabaseError(error),
      );

      acknowledgeError(
        callback,
        "Message could not be saved. Please try again.",
      );
    }
  });

  socket.on("disconnect", (reason) => {
    logger.log("Client disconnected:", socket.id, reason);
  });
}

module.exports = { registerMessageHandlers };
