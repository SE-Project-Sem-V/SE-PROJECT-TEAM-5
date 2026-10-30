const { ERROR_CATALOGUE } = require("./errors");

const publicCodes = new Set(Object.keys(ERROR_CATALOGUE));
const databaseCodes = new Set([
  "DB_CONFIGURATION_FAILED", "DB_CONNECTION_FAILED", "DB_AUTH_FAILED", "DB_OPERATION_FAILED",
]);
const groupCodes = new Set([
  "INVALID_INPUT", "ROOM_NOT_FOUND", "ROOM_ACCESS_DENIED", "ROOM_CREATOR_REQUIRED",
  "GROUP_ROOM_REQUIRED", "MEMBER_REJOIN_REQUIRED",
]);
const groupStatuses = Object.freeze({
  INVALID_INPUT: 400, ROOM_NOT_FOUND: 404, ROOM_ACCESS_DENIED: 403,
  ROOM_CREATOR_REQUIRED: 403, GROUP_ROOM_REQUIRED: 400, MEMBER_REJOIN_REQUIRED: 409,
});
const events = Object.freeze({
  "http.request.failed": { codes: publicCodes, fields: { status: [400, 401, 403, 404, 409, 413, 415, 500] } },
  "group.operation.failed": { codes: groupCodes, fields: { status: [400, 403, 404, 409] } },
  "auth.socket.failed": { codes: new Set(["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_EXPIRED"]), fields: {} },
  "message.invalid": { codes: new Set(["INVALID_MESSAGE"]), fields: { scope: ["direct", "group"] } },
  "message.rejected": { codes: new Set([
    "CONVERSATION_NOT_FOUND", "ROOM_FORBIDDEN", "CLIENT_ID_CONFLICT",
    "GROUP_ROOM_NOT_FOUND", "ROOM_ACCESS_DENIED",
  ]), fields: { scope: ["direct", "group"] } },
  "message.save.failed": { codes: new Set(["INTERNAL_ERROR"]), fields: { scope: ["direct", "group"] } },
  "message.broadcast.failed": { codes: new Set(["INTERNAL_ERROR"]), fields: { scope: ["direct", "group"] } },
  "message.ack.failed": { codes: new Set(["INTERNAL_ERROR"]), fields: { scope: ["direct", "group"] } },
  "socket.ack.failed": { codes: new Set(["INTERNAL_ERROR"]), fields: {} },
  "presence.update.failed": { codes: new Set(["PRESENCE_UPDATE_FAILED"]), fields: { operation: ["online", "offline", "snapshot", "join"] } },
  "database.idle.failed": { codes: databaseCodes, fields: {} },
  "database.command.failed": { codes: databaseCodes, fields: { operation: ["migrate", "seed", "check", "unknown"] } },
  "server.start.failed": { codes: new Set(["CONFIG_FAILURE", "SERVER_BIND_FAILED", ...databaseCodes]), fields: {} },
  "server.shutdown.failed": { codes: new Set(["INTERNAL_ERROR"]), fields: {} },
  "server.fatal": { codes: new Set(["INTERNAL_ERROR"]), fields: {} },
});

// Construct the record from known fields only. Neither an exception nor an
// arbitrary caller-owned object is ever serialized or passed to the sink.
function logFailure(logger, event, code, metadata = {}) {
  try {
    const rule = Object.hasOwn(events, event) ? events[event] : null;
    if (!rule || !rule.codes.has(code)) return false;
    const record = { level: "error", event, code };
    for (const [field, allowed] of Object.entries(rule.fields)) {
      if (!Object.hasOwn(metadata, field) || !allowed.includes(metadata[field])) return false;
      record[field] = metadata[field];
    }
    if (event === "http.request.failed" && record.status !== ERROR_CATALOGUE[code].status) return false;
    if (event === "group.operation.failed" && record.status !== groupStatuses[code]) return false;
    logger.error(JSON.stringify(record));
  } catch {
    // Logging must not change the response or mask the original failure.
    return false;
  }
  return true;
}

module.exports = { logFailure };
