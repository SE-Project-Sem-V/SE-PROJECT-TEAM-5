import { getDirectMessages } from './api.js';
import { USE_MOCK } from './config.js';
import { normalizeMessage } from './messages.js';

// Loads the saved messages between the logged-in user (meId) and peerId, oldest first.
// The real request lives in api.js (getDirectMessages -> GET /api/users/:userId/messages).
export async function fetchHistory(peerId, token, meId) {
  if (USE_MOCK) {
    // Demo messages so the history screen can be tried without a backend.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const day = 24 * 60 * 60 * 1000;
    const start = Date.now() - day;
    return [
      normalizeMessage({ id: `h-${peerId}-1`, userId: peerId, to: meId, text: 'Hi! Welcome to Team 5 Chat.', timestamp: start }),
      normalizeMessage({ id: `h-${peerId}-2`, userId: meId, to: peerId, text: 'Thanks! Glad to be here.', timestamp: start + 60000 }),
      normalizeMessage({ id: `h-${peerId}-3`, userId: peerId, to: meId, text: 'See you at the stand-up.', timestamp: start + 120000 }),
    ];
  }

  const list = await getDirectMessages(peerId, token);
  return list.map((raw) => {
    const m = normalizeMessage(raw);
    return { ...m, to: m.to ?? (m.from === meId ? peerId : meId) };
  });
}