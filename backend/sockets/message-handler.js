
const { formatDatabaseError } = require("../db/config");
const {
  validateMessage,
  saveDirectMessage,
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

    const validationError = validateMessage(
      payload,
      senderId,
      maxMessageLength,
    );

    if (validationError) {
      return acknowledgeError(callback, validationError);
    }

    try {
      const message = await saveDirectMessage(
        pool,
        senderId,
        payload.to,
        payload.text,
        payload.clientId,
      );

      // Acknowledge only after the database transaction succeeds.
      callback({ ok: true, message });

      // Deliver the persisted message to the recipient's connected clients.
      io.to(`user:${message.to}`).emit("newMessage", message);
    } catch (error) {
      const knownErrors = {
        DIRECT_ROOM_NOT_FOUND:
          "No direct conversation exists with this recipient.",
        ACTIVE_MEMBERSHIP_REQUIRED:
          "Both users must be active members of the conversation.",
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
