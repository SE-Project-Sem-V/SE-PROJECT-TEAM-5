// Public errors are an allowlist, never a serialization of an exception.
const ERROR_CATALOGUE = Object.freeze(Object.fromEntries(Object.entries({
  AUTH_REQUIRED: [401, "Authentication required."],
  AUTH_INVALID: [401, "Invalid authentication."],
  AUTH_EXPIRED: [401, "Authentication expired."],
  INVALID_CREDENTIALS: [401, "Invalid username or password."],
  INVALID_INPUT: [400, "Invalid request."],
  INVALID_MESSAGE: [400, "Invalid message payload."],
  INVALID_JSON: [400, "Invalid JSON request."],
  PAYLOAD_TOO_LARGE: [413, "Request body is too large."],
  UNSUPPORTED_ENCODING: [415, "Unsupported request encoding."],
  USERNAME_TAKEN: [409, "Username is already taken."],
  RECIPIENT_NOT_FOUND: [404, "Recipient not found."],
  CONVERSATION_NOT_FOUND: [404, "No direct conversation exists with this recipient."],
  ROOM_FORBIDDEN: [403, "Both users must be active members of the conversation."],
  CLIENT_ID_CONFLICT: [409, "This clientId was already used for a different message."],
  NOT_FOUND: [404, "Not found."],
  INTERNAL_ERROR: [500, "Internal server error."],
}).map(([code, [status, message]]) => [code, Object.freeze({ code, status, message })])));

const VARIANTS = Object.freeze({
  AUTH_REQUIRED: { socket: "Authentication required" },
  AUTH_INVALID: { http: "Authentication required.", socket: "Invalid or expired token", payload: "Invalid token payload" },
  AUTH_EXPIRED: { http: "Authentication required.", socket: "Invalid or expired token" },
  INVALID_INPUT: {
    registration: "Valid username, password, and display name are required.",
    password: "Password must be nonempty and within the allowed length.",
    login: "Username and password are required.",
    search: "Use a single q parameter of at most 64 characters without control characters.",
    recipient: "Invalid recipient ID.",
    selfConversation: "You cannot start a conversation with yourself.",
    selfHistory: "You cannot load a conversation with yourself.",
  },
  INVALID_MESSAGE: {
    sender: "This account cannot send database messages.",
    recipient: "A valid recipient is required.",
    self: "You cannot send a direct message to yourself.",
    clientId: "A valid clientId is required.",
  },
  INTERNAL_ERROR: { messageSave: "Message could not be saved. Please try again." },
});

// The private representation prevents arbitrary exceptions, mutated fields and
// forged prototypes from opting into public messages.
const applicationErrors = new WeakMap();

class AppError extends Error {
  constructor(code, variant, maxLength) {
    const definition = Object.hasOwn(ERROR_CATALOGUE, code)
      ? ERROR_CATALOGUE[code] : ERROR_CATALOGUE.INTERNAL_ERROR;
    let message = definition.message;
    const variants = Object.hasOwn(VARIANTS, definition.code) ? VARIANTS[definition.code] : null;
    if (variants && Object.hasOwn(variants, variant)) message = variants[variant];
    if (definition.code === "INVALID_MESSAGE" && variant === "length" &&
        Number.isSafeInteger(maxLength) && maxLength > 0) {
      message = `Message must contain text and be at most ${maxLength} characters.`;
    }
    super(message);
    this.name = "AppError";
    this.code = definition.code;
    this.status = definition.status;
    applicationErrors.set(this, Object.freeze({ ...definition, message }));
  }
}

function normalizeError(error) {
  return applicationErrors.get(error) || ERROR_CATALOGUE.INTERNAL_ERROR;
}

function httpErrorResponse(error) {
  const { status, code, message } = normalizeError(error);
  return { status, body: { status: "error", code, message } };
}

function sendHttpError(res, error) {
  const { status, body } = httpErrorResponse(error);
  return res.status(status).json(body);
}

function socketErrorResponse(error) {
  const { code, message } = normalizeError(error);
  return { ok: false, code, message, error: message };
}

function socketConnectionError(error) {
  const { code, message } = normalizeError(error);
  const connectionError = new Error(message);
  connectionError.data = { code, message };
  return connectionError;
}

// CHATAPP-27 remains the validation authority. Only its controlled explanations
// are accepted here, never request values or arbitrary exception messages.
function messageValidationError(message, maxLength) {
  for (const [variant, explanation] of Object.entries(VARIANTS.INVALID_MESSAGE)) {
    if (message === explanation) return new AppError("INVALID_MESSAGE", variant);
  }
  if (Number.isSafeInteger(maxLength) && maxLength > 0 &&
      message === `Message must contain text and be at most ${maxLength} characters.`) {
    return new AppError("INVALID_MESSAGE", "length", maxLength);
  }
  return new AppError("INVALID_MESSAGE");
}

module.exports = {
  ERROR_CATALOGUE, AppError, normalizeError, httpErrorResponse, sendHttpError,
  socketErrorResponse, socketConnectionError, messageValidationError,
};
