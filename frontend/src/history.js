import { API_URL, USE_MOCK, assertSecureTransport } from './config.js';
import { normalizeMessage } from './messages.js';

// ASSUMED endpoint: the SAD does not define chat history yet (CHAT-F-011).
// Change this one line if the backend uses a different path.
const historyPath = (peerId) => `/api/messages/history?userId=${encodeURIComponent(peerId)}&limit=50`;

const wait = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// Loads the recent messages between the logged-in user (meId) and peerId, oldest first.
export async function fetchHistory(peerId, token, meId) {
  if (USE_MOCK) {
    await wait();
    const day = 24 * 60 * 60 * 1000;
    const start = Date.now() - day;
    return [
      normalizeMessage({ id: `h-${peerId}-1`, userId: peerId, to: meId, text: 'Hi! Welcome to Team 5 Chat.', timestamp: start }),
      normalizeMessage({ id: `h-${peerId}-2`, userId: meId, to: peerId, text: 'Thanks! Glad to be here.', timestamp: start + 60000 }),
      normalizeMessage({ id: `h-${peerId}-3`, userId: peerId, to: meId, text: 'See you at the stand-up.', timestamp: start + 120000 }),
    ];
  }

  assertSecureTransport();
  let response;
  try {
    response = await fetch(`${API_URL}${historyPath(peerId)}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = data.error;
    throw new Error((typeof e === 'string' ? e : e?.message) || data.message || `Could not load history (error ${response.status}).`);
  }
  const list = Array.isArray(data) ? data : data.messages || [];
  return list.map((raw) => {
    const m = normalizeMessage(raw);
    return { ...m, to: m.to ?? (m.from === meId ? peerId : meId) };
  });
}