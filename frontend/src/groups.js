import { API_URL, USE_MOCK, assertSecureTransport } from './config.js';
import { normalizeMessage } from './messages.js';
import { apiError } from './session.js';

// ASSUMED backend contract for group chat (CHATAPP-15 and 16 are not built yet).
// Agree these with the backend developer, then change only this file if they differ:
//   GET  /api/rooms                     -> { rooms: [{ id, name, members: [{ id, username }] }] }
//   POST /api/rooms { name, memberIds } -> { room: { id, name, members } }
//   GET  /api/rooms/:roomId/messages    -> { messages: [{ id, from, roomId, content, timestamp }] }
// Sending and receiving use the socket: sendMessage { roomId, text, clientId } and newMessage (with the roomId).

const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

let mockRooms = []; // demo data that lives until the page is refreshed

async function request(path, { method = 'GET', body, token } = {}) {
  assertSecureTransport();
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(response.status, data, token);
  }
  return data;
}

function normalizeRoom(r) {
  return {
    id: String(r.id),
    name: r.name ?? 'Group',
    members: (r.members ?? []).map((m) => ({
      id: String(m.id ?? m.userId),
      username: m.username ?? m.display_name ?? 'Member',
    })),
  };
}

// The groups the logged-in user belongs to.
export async function listRooms(token) {
  if (USE_MOCK) {
    await wait(150);
    return [...mockRooms];
  }
  const data = await request('/api/rooms', { token });
  return (Array.isArray(data) ? data : data.rooms || []).map(normalizeRoom);
}

// CHAT-F-008: create a group and add members. `members` is a list of { id, username }; `me` is the creator.
export async function createRoom({ name, members, me }, token) {
  if (USE_MOCK) {
    await wait();
    const room = {
      id: `mock-group-${mockRooms.length + 1}`,
      name,
      members: [{ id: me.id, username: me.username }, ...members],
    };
    mockRooms = [room, ...mockRooms];
    return room;
  }
  const data = await request('/api/rooms', {
    method: 'POST',
    token,
    body: { name, memberIds: members.map((m) => m.id) },
  });
  return normalizeRoom(data.room ?? data);
}

// Saved messages of a group, oldest first.
export async function fetchRoomMessages(roomId, token) {
  if (USE_MOCK) {
    await wait(150);
    return [];
  }
  const data = await request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { token });
  const list = Array.isArray(data) ? data : data.messages || [];
  return list.map((raw) => ({ ...normalizeMessage(raw), roomId: String(raw.roomId ?? roomId) }));
}
