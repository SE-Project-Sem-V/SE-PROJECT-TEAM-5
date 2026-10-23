import { API_URL, USE_MOCK, assertSecureTransport } from './config.js';

const MOCK_USERS = [
  { id: 'u1', username: 'alice', online: true },
  { id: 'u2', username: 'bob', online: false },
  { id: 'u3', username: 'charlie', online: true },
];

const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads the error text from the server's standard error body. SAD 4.3 lists 401 and 400 for login.
function errorMessage(status, data) {
  const e = data.error;
  const text = typeof e === 'string' ? e : e?.message || data.message;
  if (text) return text;
  if (status === 401) return 'Incorrect username or password.';
  if (status === 400) return 'The request was not valid. Check what you entered.';
  return `Something went wrong (error ${status}). Try again.`;
}

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
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(response.status, data));
  return data;
}

// SAD 4.3 login response: { status: "ok", token, userId }.
function toSession(data, username) {
  return { token: data.token, user: { id: String(data.userId ?? data.user?.id), username } };
}

export async function login(username, password) {
  if (USE_MOCK) {
    await wait();
    if (!password) throw new Error('Enter your password.');
    return { token: `mock-${username}`, user: { id: `me-${username}`, username } };
  }
  const data = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  return toSession(data, username);
}

export async function register(username, password) {
  if (USE_MOCK) {
    await wait();
    if (!password) throw new Error('Enter a password.');
    return { token: `mock-${username}`, user: { id: `me-${username}`, username } };
  }
  const data = await request('/api/auth/register', { method: 'POST', body: { username, password } });
  // If the server does not log the user in on registration, log in right away.
  return data.token ? toSession(data, username) : login(username, password);
}

// CHAT-F-002: tell the server to invalidate the session.
export async function logout(token) {
  if (USE_MOCK) {
    await wait(100);
    return;
  }
  await request('/api/auth/logout', { method: 'POST', token });
}

function normalizeUser(u) {
  return { id: String(u.id ?? u.userId), username: u.username, online: Boolean(u.online) };
}

export async function searchUsers(query, token) {
  if (USE_MOCK) {
    await wait(150);
    const q = query.toLowerCase();
    return MOCK_USERS.filter((u) => u.username.includes(q));
  }
  const data = await request(`/api/users?q=${encodeURIComponent(query)}`, { token });
  return (Array.isArray(data) ? data : data.users || []).map(normalizeUser);
}
