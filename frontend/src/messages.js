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

// Adds a message to a conversation unless one with the same id is already there.
// Protects against duplicates after a reconnect (STP INT-07: no duplicate messages).
export function appendUnique(list, message) {
  return list.some((m) => m.id === message.id) ? list : [...list, message];
}

// Reads an online/offline update from the server. Returns null if it cannot be understood.
export function normalizePresence(raw) {
  const id = raw.userId ?? raw.id;
  const online =
    raw.online ?? raw.isOnline ?? (typeof raw.status === 'string' ? raw.status.toLowerCase() === 'online' : undefined);
  if (id === undefined || id === null || online === undefined) return null;
  return { userId: String(id), online: Boolean(online) };
}

// Combines history from the server with the messages already on screen: no duplicates, oldest first.
// Messages already on screen win, so a message that is still sending keeps its status.
export function mergeHistory(history, current) {
  const byId = new Map();
  [...history, ...current].forEach((m) => byId.set(m.id, m));
  return [...byId.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}