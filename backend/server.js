
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
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

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("ping", (callback) => {
    if (typeof callback === "function") {
      callback({ status: "success", message: "pong" });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Chat backend running on http://localhost:${PORT}`);
});
