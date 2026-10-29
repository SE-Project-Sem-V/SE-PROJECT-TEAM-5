
const { AppError, normalizeError, socketErrorResponse, messageValidationError } = require("../errors");
const { logFailure } = require("../logging");
const {
  validateMessage,
  saveDirectMessage,
  validateGroupMessage,
  saveGroupMessage,
} = require("../services/message-service");

function acknowledgeError(callback, error, logger, scope) {
  if (typeof callback === "function") {
    try {
      callback(socketErrorResponse(error));
    } catch {
      logFailure(logger, "message.ack.failed", "INTERNAL_ERROR", { scope });
    }
  }
}

function registerMessageHandlers({
  io,
  socket,
  pool,
  maxMessageLength,
  logger = console,
  onDisconnect,
}) {
  const senderId = socket.data.user.id;

  try {
    socket.join(`user:${senderId}`);
  } catch {
    logFailure(logger, "presence.update.failed", "PRESENCE_UPDATE_FAILED", { operation: "join" });
    if (typeof onDisconnect === "function") {
      try {
        onDisconnect();
      } catch {
        logFailure(logger, "presence.update.failed", "PRESENCE_UPDATE_FAILED", { operation: "offline" });
      }
    }
    try {
      socket.disconnect(true);
    } catch {
      logFailure(logger, "presence.update.failed", "PRESENCE_UPDATE_FAILED", { operation: "join" });
    }
    return;
  }

  socket.on("protected:ping", (callback) => {
    if (typeof callback !== "function") return;

    try {
      callback({
        status: "success",
        message: "pong",
        userId: senderId,
      });
    } catch {
      logFailure(logger, "socket.ack.failed", "INTERNAL_ERROR");
    }
  });

  socket.on("sendMessage", async (payload, callback) => {
    if (typeof callback !== "function") return;

    // Group payloads have roomId; direct payloads have to.
    const isGroupMessage =
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.prototype.hasOwnProperty.call(payload, "roomId");
    const scope = isGroupMessage ? "group" : "direct";

    const validationError = isGroupMessage
      ? validateGroupMessage(payload, senderId, maxMessageLength)
      : validateMessage(payload, senderId, maxMessageLength);

    if (validationError) {
      logFailure(logger, "message.invalid", "INVALID_MESSAGE", { scope });
      return acknowledgeError(callback, messageValidationError(validationError, maxMessageLength), logger, scope);
    }

    let result;
    try {
      result = isGroupMessage
        ? await saveGroupMessage(pool, senderId, payload.roomId, payload.text, payload.clientId)
        : await saveDirectMessage(pool, senderId, payload.to, payload.text, payload.clientId);
    } catch (error) {
      const code = normalizeError(error).code;
      if (code !== "INTERNAL_ERROR") {
        logFailure(logger, "message.rejected", code, { scope });
        return acknowledgeError(callback, error, logger, scope);
      }
      logFailure(logger, "message.save.failed", "INTERNAL_ERROR", { scope });
      return acknowledgeError(callback, new AppError("INTERNAL_ERROR", "messageSave"), logger, scope);
    }

    try {
      callback({ ok: true, message: isGroupMessage ? result.message : result });
    } catch {
      logFailure(logger, "message.ack.failed", "INTERNAL_ERROR", { scope });
      return;
    }

    try {
      if (isGroupMessage) {
        // A retry receives the original acknowledgement but isn't broadcast again.
        if (result.created) {
          const broadcastMessage = {
            id: result.message.id,
            from: result.message.userId,
            roomId: result.message.roomId,
            content: result.message.text,
            timestamp: result.message.timestamp,
          };
          for (const memberId of result.recipientIds) {
            io.to(`user:${memberId}`).emit("newMessage", broadcastMessage);
          }
        }
      } else {
        io.to(`user:${result.to}`).emit("newMessage", result);
      }
    } catch {
      logFailure(logger, "message.broadcast.failed", "INTERNAL_ERROR", { scope });
    }
  });

  socket.on("disconnect", () => {
    if (typeof onDisconnect === "function") {
      try {
        onDisconnect();
      } catch {
        logFailure(logger, "presence.update.failed", "PRESENCE_UPDATE_FAILED", { operation: "offline" });
      }
    }
  });
}

module.exports = { registerMessageHandlers };
