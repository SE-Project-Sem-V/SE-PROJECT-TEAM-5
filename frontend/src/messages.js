// Converts the server's timestamp (ISO string, epoch milliseconds or epoch seconds) to an ISO string.
export function toIso(value) {
  if (value === null || value === undefined) return undefined;
  const ms = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Maps a message from the server to the shape the UI uses.
// Accepts the field names in SAD 4.3 (userId, text) and the SRS-style names (from, content).
export function normalizeMessage(raw, defaults = {}) {
  const from = raw.userId ?? raw.from ?? raw.senderId ?? defaults.from;
  return {
    id: raw.id ?? raw.messageId ?? defaults.id ?? `m-${Date.now()}`,
    from: from === undefined || from === null ? undefined : String(from),
    to: raw.to ?? defaults.to,
    roomId: raw.roomId,
    content: raw.text ?? raw.content ?? defaults.content,
    timestamp: toIso(raw.timestamp) ?? defaults.timestamp ?? new Date().toISOString(),
  };
}
