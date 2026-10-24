const JWT_SECRET_ERROR = "JWT_SECRET must be a whitespace-free string of at least 32 UTF-8 bytes. Generate it from at least 32 cryptographically random bytes and keep it private.";

class SecurityConfigurationError extends Error {
  constructor() {
    super(JWT_SECRET_ERROR);
    this.name = "SecurityConfigurationError";
  }
}

function validateJwtSecret(value) {
  // Length is a guardrail, not an entropy test. Provision a random key; never
  // silently trim, replace, hash, or regenerate a configured signing key.
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32 ||
      /\s/.test(value) || /^(.)\1*$/u.test(value)) {
    throw new SecurityConfigurationError();
  }
  return value;
}

module.exports = { validateJwtSecret, SecurityConfigurationError, JWT_SECRET_ERROR };
