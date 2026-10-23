
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");

const URL = "http://localhost:5000";
const secret = process.env.JWT_SECRET;

if (!secret) {
  throw new Error("JWT_SECRET is missing from backend/.env");
}

const validToken = jwt.sign(
  { sub: "test-user-1" },
  secret,
  { expiresIn: "5m" }
);

const expiredToken = jwt.sign(
  { sub: "test-user-1" },
  secret,
  { expiresIn: -10 }
);

function connectWithAuth(auth) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      auth,
      reconnection: false,
      timeout: 3000,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Test timed out"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve({ rejected: true, message: error.message });
    });
  });
}

async function runTests() {
  let failures = 0;

  async function expectRejected(name, auth) {
    try {
      const result = await connectWithAuth(auth);

      if (result.rejected) {
        console.log(`PASS: ${name} was rejected`);
      } else {
        console.error(`FAIL: ${name} was accepted`);
        failures++;
        result.disconnect();
      }
    } catch (error) {
      console.error(`FAIL: ${name}: ${error.message}`);
      failures++;
    }
  }

  // Valid token must connect and access the protected operation.
  try {
    const socket = await connectWithAuth({ token: validToken });

    if (socket.rejected) {
      throw new Error(socket.message);
    }

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Protected operation timed out")),
        3000
      );

      socket.emit("protected:ping", (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    if (
      response.status === "success" &&
      response.userId === "test-user-1"
    ) {
      console.log("PASS: valid JWT can access protected operation");
    } else {
      console.error("FAIL: unexpected protected operation response");
      failures++;
    }

    socket.disconnect();
  } catch (error) {
    console.error("FAIL: valid JWT test:", error.message);
    failures++;
  }

  await expectRejected("missing JWT", {});
  await expectRejected("invalid JWT", {
    token: "not.a.valid.token",
  });
  await expectRejected("expired JWT", {
    token: expiredToken,
  });

  console.log(
    failures === 0
      ? "ALL AUTHENTICATION TESTS PASSED"
      : `${failures} AUTHENTICATION TEST(S) FAILED`
  );

  process.exitCode = failures === 0 ? 0 : 1;
}

runTests();
