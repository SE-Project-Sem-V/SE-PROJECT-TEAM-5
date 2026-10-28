
const { formatDatabaseError } = require("../db/config");
const { AppError, normalizeError, socketErrorResponse, messageValidationError } = require("../errors");
const {
  validateMessage,
  saveDirectMessage,
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

    const validationError = validateMessage(
      payload,
      senderId,
      maxMessageLength,
    );

    if (validationError) {
      return acknowledgeError(callback, messageValidationError(validationError, maxMessageLength));
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
