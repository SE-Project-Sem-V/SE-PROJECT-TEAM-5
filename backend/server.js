
const express = require("express");
const http = require("node:http");
const path = require("node:path");
const cors = require("cors");
const { Server } = require("socket.io");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
  quiet: true,
});

const { createAuthRouter } = require("./routes/auth");
const { createPool } = require("./db/pool");
const { databaseFailureCode } = require("./db/config");
const { logFailure } = require("./logging");
const {
  validateJwtSecret,
  SecurityConfigurationError,
} = require("./security/config");
const {
  createHttpErrorHandler,
  notFound,
} = require("./middleware/error-handler");
const { createUsersRouter } = require("./routes/users");
const { createRoomsRouter } = require("./routes/rooms");
const { createSocketAuthMiddleware } = require("./sockets/socket-auth");
const { registerMessageHandlers } = require("./sockets/message-handler");
const { createPresenceTracker } = require("./sockets/presence");
const { createSessionLifecycle, endSessionSocket } = require("./sockets/session-lifecycle");
const { saveDirectMessage } = require("./services/message-service");

class ServerBindError extends Error {}

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

  app.use((_req, res, next) => {
    res.locals.logFailure = (event, code, metadata) => logFailure(logger, event, code, metadata);
    next();
  });
  app.use(cors());
  app.use(express.json());
  const sessions = createSessionLifecycle(pool, logger);
  app.use("/api/auth", createAuthRouter({ pool, jwtSecret, onLogout: sessions.disconnectSession }));

  const io = new Server(server, {
    cors: {
      origin: clientUrl,
      methods: ["GET", "POST"],
    },
  });

  const presence = createPresenceTracker(io, logger);

  app.get("/api/ping", (req, res) => {
    res.status(200).json({
      status: "success",
      message: "pong",
      service: "chat-backend",
    });
  });

  app.use("/api/users", createUsersRouter({ pool, jwtSecret }));
  app.use("/api/rooms", createRoomsRouter({ pool, jwtSecret }));

  // Register future HTTP routes above these final response/error handlers.
  app.use(notFound);
  app.use(createHttpErrorHandler(logger));

  // Authenticate Socket.IO connections using JWT.
  io.use(createSocketAuthMiddleware({ pool, jwtSecret, logger, onAuthenticated: sessions.track }));

  // Track authenticated users and publish presence updates.
  io.on("connection", (socket) => {
    if (socket.data.sessionEnded) {
      endSessionSocket(socket, socket.data.sessionFailure, logger);
      return;
    }
    const userId = String(socket.data.user.id);

    // Send the connecting user the current online-user snapshot.
    for (const onlineUserId of presence.getOnlineUserIds()) {
      try {
        socket.emit("presenceUpdate", {
          userId: onlineUserId,
          online: true,
        });
      } catch {
        logFailure(logger, "presence.update.failed", "PRESENCE_UPDATE_FAILED", { operation: "snapshot" });
      }
    }

    // Announce online status only when this user's first connection appears.
    presence.addConnection(userId, socket.id);

    registerMessageHandlers({
      io,
      socket,
      pool,
      maxMessageLength,
      logger,
      onDisconnect: () => {
        presence.removeConnection(userId, socket.id);
      },
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

  const pool = createPool(process.env, console);
  const chat = createChatServer({ pool, jwtSecret });
  const port = Number(process.env.PORT) || 5000;

  try {
    await chat.listen(port, "0.0.0.0");
    console.log(`Chat backend running on http://localhost:${port}`);
  } catch (error) {
    await pool.end();
    throw new ServerBindError();
  }

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}; shutting down chat backend.`);

    try {
      await chat.close();
      await pool.end();
    } catch {
      logFailure(console, "server.shutdown.failed", "INTERNAL_ERROR");
      process.exitCode = 1;
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function installFatalHandlers(logger = console) {
  let fatal = false;
  const onFatal = () => {
    if (fatal) return;
    fatal = true;
    logFailure(logger, "server.fatal", "INTERNAL_ERROR");
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
}

if (require.main === module) {
  installFatalHandlers();
  main().catch((error) => {
    const code = error instanceof SecurityConfigurationError ? "CONFIG_FAILURE"
      : error instanceof ServerBindError ? "SERVER_BIND_FAILED" : databaseFailureCode(error);
    logFailure(console, "server.start.failed", code);
    process.exitCode = 1;
  });
}

module.exports = { createChatServer, saveDirectMessage, installFatalHandlers };
