
const { formatDatabaseError } = require("../db/config");
const { AppError, ERROR_CATALOGUE ,normalizeError, socketErrorResponse, messageValidationError } = require("../errors");
const {
  validateMessage,
  saveDirectMessage,
  validateGroupMessage,
  saveGroupMessage,
} = require("../services/message-service");

function acknowledgeError(callback, error) {
  if (typeof callback === "function") {
    callback(socketErrorResponse(error));
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
      return acknowledgeError(callback, messageValidationError(validationError, maxMessageLength));
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
        DIRECT_ROOM_NOT_FOUND: "CONVERSATION_NOT_FOUND",
        ACTIVE_MEMBERSHIP_REQUIRED: "ROOM_FORBIDDEN",
        GROUP_ROOM_NOT_FOUND: "GROUP_ROOM_NOT_FOUND",
        ROOM_ACCESS_DENIED: "ROOM_ACCESS_DENIED",
        CLIENT_ID_REUSED: "CLIENT_ID_CONFLICT",
      };

      const errorCode = knownErrors[error.message];

      if (errorCode && Object.hasOwn(ERROR_CATALOGUE, errorCode)) {
        return acknowledgeError(callback, new AppError(errorCode));
      }

      if (normalizeError(error).code !== "INTERNAL_ERROR") {
        return acknowledgeError(callback, error);
      }

      logger.error(
        "[messages] Failed to save message:",
        formatDatabaseError(error),
      );

      acknowledgeError(
        callback,
        new AppError("INTERNAL_ERROR", "messageSave"),
      );
    }
  });

  socket.on("disconnect", (reason) => {
    logger.log("Client disconnected:", socket.id, reason);
  });
}

module.exports = { registerMessageHandlers };
