const argon2 = require("argon2");

// Match the Argon2id policy used by CHATAPP-38 seed hashes.
const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});
const MAX_PASSWORD_BYTES = 1024;

class PasswordInputError extends Error {
  constructor() {
    super(`Password must be a nonempty string of at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`);
    this.name = "PasswordInputError";
  }
}

function validPassword(password) {
  return typeof password === "string" && password.length > 0 &&
    password.isWellFormed() && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

async function hashPassword(password) {
  if (!validPassword(password)) throw new PasswordInputError();
  try {
    // node-argon2 generates a fresh random salt and returns the encoded PHC hash.
    return await argon2.hash(password, ARGON2_OPTIONS);
  } catch {
    // Do not propagate library errors or attach input as an error cause.
    throw new Error("Password hashing failed.");
  }
}

async function verifyPassword(password, encodedHash) {
  if (!validPassword(password) || typeof encodedHash !== "string" ||
      encodedHash.length > 512 || !encodedHash.startsWith("$argon2id$")) return false;
  try {
    return await argon2.verify(encodedHash, password);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, PasswordInputError, MAX_PASSWORD_BYTES };
