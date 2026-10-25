
const express = require("express");
const http = require("node:http");
const path = require("node:path");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const { createAuthRouter } = require("./routes/auth");

const { createPool, withTransaction } = require("./db/pool");
const { formatDatabaseError } = require("./db/config");
const { validateJwtSecret, SecurityConfigurationError, JWT_SECRET_ERROR } = require("./security/config");
const { createHttpErrorHandler, notFound } = require("./middleware/error-handler");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function acknowledgeError(callback, message) {
  if (typeof callback === "function") {
    callback({ ok: false, error: message });
  }
}

function validateMessage(payload, senderId, maxLength) {
  if (!UUID_PATTERN.test(senderId)) {
    return "This account cannot send database messages.";
  }

  if (!payload || typeof payload !== "object") {
    return "Invalid message payload.";
  }

  const { to, text, clientId } = payload;

  if (typeof to !== "string" || !UUID_PATTERN.test(to)) {
    return "A valid recipient is required.";
  }

  if (to === senderId) {
    return "You cannot send a direct message to yourself.";
  }

  if (typeof text !== "string" || !text.trim() || text.length > maxLength) {
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

async function saveDirectMessage(pool, senderId, recipientId, text, clientId) {
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
      throw new Error("DIRECT_ROOM_NOT_FOUND");
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
      throw new Error("ACTIVE_MEMBERSHIP_REQUIRED");
    }

    const insertResult = await client.query(
      `INSERT INTO messages (room_id, sender_id, content, client_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sender_id, client_id) DO NOTHING
       RETURNING id, room_id, sender_id, content, created_at`,
      [roomId, senderId, text, clientId],
    );

    let row = insertResult.rows[0];

    if (!row) {
      const existingResult = await client.query(
        `SELECT id, room_id, sender_id, content, created_at
         FROM messages
         WHERE sender_id = $1 AND client_id = $2`,
        [senderId, clientId],
      );

      row = existingResult.rows[0];

      if (!row || row.room_id !== roomId || row.content !== text) {
        throw new Error("CLIENT_ID_REUSED");
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

function createChatServer({
  pool,
  jwtSecret = process.env.JWT_SECRET,
  clientUrl = process.env.CLIENT_URL || "http://localhost:5173",
  maxMessageLength = Number(process.env.MAX_MESSAGE_LENGTH) || 1000,
  logger = console,
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("A PostgreSQL pool is required.");
  }

  validateJwtSecret(jwtSecret);

  const app = express();
  const server = http.createServer(app);

  app.use(cors());
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ pool, jwtSecret }));

  const io = new Server(server, {
    cors: {
      origin: clientUrl,
      methods: ["GET", "POST"],
    },
  });

  app.get("/api/ping", (req, res) => {
    res.status(200).json({
      status: "success",
      message: "pong",
      service: "chat-backend",
    });
  });

  // Register future HTTP routes above these final response/error handlers.
  app.use(notFound);
  app.use(createHttpErrorHandler(logger));

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token) {
      return next(new Error("Authentication required"));
    }

    try {
      const payload = jwt.verify(token, jwtSecret);

      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.sub !== "string" ||
        !payload.sub
      ) {
        return next(new Error("Invalid token payload"));
      }

      socket.data.user = { id: payload.sub };
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
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

        // This acknowledgement follows a successful database commit.
        callback({ ok: true, message });
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
  });

  return {
    app,
    server,
    io,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };

        const onListening = () => {
          server.off("error", onError);
          resolve(server.address());
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          io.close((error) => (error ? reject(error) : resolve()));
        });
      } else {
        io.close();
      }
    },
  };
}

async function main() {
  const jwtSecret = validateJwtSecret(process.env.JWT_SECRET);

  const pool = createPool();
  const chat = createChatServer({ pool, jwtSecret });
  const port = Number(process.env.PORT) || 5000;

  try {
    await chat.listen(port, "0.0.0.0");
    console.log(`Chat backend running on http://localhost:${port}`);
  } catch (error) {
    await pool.end();
    throw error;
  }

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}; shutting down chat backend.`);

    try {
      await chat.close();
      await pool.end();
    } catch (error) {
      console.error(
        "[database] Error during shutdown:",
        formatDatabaseError(error),
      );
      process.exitCode = 1;
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Chat backend failed to start:",
      error instanceof SecurityConfigurationError ? JWT_SECRET_ERROR : formatDatabaseError(error));
    process.exitCode = 1;
  });
}

module.exports = { createChatServer, saveDirectMessage };
