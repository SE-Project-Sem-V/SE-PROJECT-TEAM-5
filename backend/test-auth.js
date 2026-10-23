
const { io } = require("socket.io-client");

const token = process.env.TEST_JWT;

if (!token) {
  throw new Error("Set TEST_JWT to the temporary test token.");
}

const socket = io("http://localhost:5000", {
  auth: { token },
  reconnection: false,
});

socket.on("connect", () => {
  console.log("PASS: authenticated connection established");

  socket.emit("protected:ping", (response) => {
    console.log("Protected operation response:", response);
    socket.disconnect();
  });
});

socket.on("connect_error", (error) => {
  console.error("Connection rejected:", error.message);
  process.exitCode = 1;
});

socket.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
});
