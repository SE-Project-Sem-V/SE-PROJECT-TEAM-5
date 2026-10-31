import {
  API_URL,
  USE_MOCK,
  assertSecureTransport,
} from './config.js';

import { apiError } from './session.js';

const MOCK_USERS = [
  { id: 'u1', username: 'alice', online: true },
  { id: 'u2', username: 'bob', online: false },
  { id: 'u3', username: 'charlie', online: true },
];
// UI simulation only. Actual persistence is provided by PostgreSQL in real mode.
const mockProfiles = new Map();
function mockProfile(username) {
  if (!mockProfiles.has(username)) mockProfiles.set(username, {
    id: `me-${username}`, username, display_name: username, status_message: null,
  });
  return mockProfiles.get(username);
}

const wait = (ms = 250) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, { method = 'GET', body, token } = {}) {
  assertSecureTransport();

  let response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      'Cannot reach the server. Check your connection and try again.',
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw apiError(response.status, data, token);
  }

  return data;
}

// SAD 4.3 login response: { status: "ok", token, userId }.
function toSession(data, username) {
  return {
    token: data.token,
    user: normalizeUser({ ...data.user, id: data.userId ?? data.user?.id,
      username: data.user?.username ?? username }),
  };
}

export async function login(username, password) {
  if (USE_MOCK) {
    await wait();

    if (!password) throw new Error('Enter your password.');

    return {
      token: `mock-${username}`,
      user: normalizeUser(mockProfile(username)),
    };
  }

  const data = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });

  return toSession(data, username);
}

export async function register(username, password, displayName) {
  if (USE_MOCK) {
    await wait();

    if (!password) throw new Error('Enter a password.');

    mockProfiles.set(username, { ...mockProfile(username), display_name: displayName });
    return {
      token: `mock-${username}`,
      user: normalizeUser(mockProfile(username)),
    };
  }

  const data = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password, displayName },
  });

  // If registration does not log the user in, log in immediately.
  return data.token ? toSession(data, username) : login(username, password);
}

// CHAT-F-002: invalidate the session on the server.
export async function logout(token) {
  if (USE_MOCK) {
    await wait(100);
    return;
  }

  await request('/api/auth/logout', {
    method: 'POST',
    token,
  });
}

function normalizeUser(user) {
  return {
    id: String(user.id ?? user.userId),
    username: user.username,
    displayName: user.display_name ?? user.displayName ?? user.username,
    statusMessage: user.status_message ?? user.statusMessage ?? null,
    online: typeof user.online === 'boolean' ? user.online : null,
  };
}

export async function getMyProfile(token) {
  if (USE_MOCK) {
    await wait();
    return normalizeUser(mockProfile(token.replace(/^mock-/, '')));
  }
  const data = await request('/api/users/me', { token });
  return normalizeUser(data.user);
}

export async function updateMyProfile(patch, token) {
  if (USE_MOCK) {
    await wait();
    const profile = mockProfile(token.replace(/^mock-/, ''));
    if (Object.hasOwn(patch, 'displayName')) profile.display_name = patch.displayName;
    if (Object.hasOwn(patch, 'statusMessage')) profile.status_message = patch.statusMessage || null;
    return normalizeUser(profile);
  }
  const data = await request('/api/users/me', { method: 'PATCH', body: patch, token });
  return normalizeUser(data.user);
}

export async function searchUsers(query, token) {
  const q = query.trim();

  if (USE_MOCK) {
    await wait(150);

    if (!q) return [];

    return MOCK_USERS.filter((user) =>
      user.username.includes(q.toLowerCase()),
    ).map(user => normalizeUser({ ...user, ...mockProfiles.get(user.username), id: user.id }));
  }

  const data = await request(
    `/api/users?q=${encodeURIComponent(q)}`,
    { token },
  );

  return (Array.isArray(data) ? data : data.users || []).map(normalizeUser);
}

// CHATAPP-11: create or retrieve the direct conversation.
export async function getOrCreateDirectConversation(userId, token) {
  if (USE_MOCK) {
    await wait(100);
    return { id: `mock-direct-${userId}` };
  }

  const data = await request(
    `/api/users/${encodeURIComponent(userId)}/conversation`,
    {
      method: 'POST',
      token,
    },
  );

  return data.conversation;
}

// CHATAPP-11: retrieve previously saved messages.
export async function getDirectMessages(userId, token) {
  if (USE_MOCK) {
    await wait(100);
    return [];
  }

  const data = await request(
    `/api/users/${encodeURIComponent(userId)}/messages`,
    { token },
  );

  return Array.isArray(data.messages) ? data.messages : [];
}
