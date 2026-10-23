
const express = require("express");
const http = require("http");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required in backend/.env");
}

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Existing health-check endpoint
app.get("/api/ping", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "pong",
    service: "chat-backend",
  });
});

// Authenticate every Socket.IO connection using its JWT.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;

  if (typeof token !== "string" || !token) {
    return next(new Error("Authentication required"));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    if (
      typeof payload !== "object" ||
      typeof payload.sub !== "string" ||
      !payload.sub
    ) {
      return next(new Error("Invalid token payload"));
    }

    // Trust the identity from the verified token, not client-supplied IDs.
    socket.data.user = { id: payload.sub };
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  console.log("Authenticated client connected:", socket.data.user.id);

  // Example protected operation.
  socket.on("protected:ping", (callback) => {
    if (typeof callback !== "function") return;

    callback({
      status: "success",
      message: "pong",
      userId: socket.data.user.id,
    });
  });

  socket.on("disconnect", (reason) => {
    console.log("Client disconnected:", socket.id, reason);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Chat backend running on http://localhost:${PORT}`);
});
