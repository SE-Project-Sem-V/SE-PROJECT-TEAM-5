import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real HTTP adapter independently of the project's mock-mode suite.
vi.mock('./config.js', async (importOriginal) => ({
  ...await importOriginal(), USE_MOCK: false, API_URL: 'http://localhost:5000',
}));

import { searchUsers } from './api.js';

function reply(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('CHATAPP-10 real user-search API adapter', () => {
  it('trims and encodes q and sends the bearer token only in the header', async () => {
    const token = crypto.randomUUID();
    fetch.mockResolvedValue(reply({ users: [] }));
    await searchUsers('  a_%\\!  ', token);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`http://localhost:5000/api/users?q=${encodeURIComponent('a_%\\!')}`);
    expect(url.includes(token)).toBe(false);
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization === `Bearer ${token}`).toBe(true);
    expect(options.body).toBeUndefined();
  });

  it('maps the public response and keeps unavailable presence distinct from offline', async () => {
    const privateValue = crypto.randomUUID();
    fetch.mockResolvedValue(reply({ users: [{ id: 'user-a', username: 'Alina', display_name: 'Alina Public',
      status_message: 'Available', password_hash: privateValue, email: privateValue, token: privateValue, session_id: privateValue }] }));
    const users = await searchUsers('ali', crypto.randomUUID());
    expect(JSON.stringify(users).includes(privateValue)).toBe(false);
    expect(users).toEqual([{ id: 'user-a', username: 'Alina', displayName: 'Alina Public', statusMessage: 'Available', online: null }]);
  });

  it('preserves explicit online/offline booleans and treats other presence values as unknown', async () => {
    fetch.mockResolvedValue(reply({ users: [
      { id: 'a', username: 'a', online: true }, { id: 'b', username: 'b', online: false },
      { id: 'c', username: 'c', online: 'false' }, { id: 'd', username: 'd', online: null },
    ] }));
    expect((await searchUsers('a', crypto.randomUUID())).map((u) => u.online)).toEqual([true, false, null, null]);
  });

  it('handles empty input and no matching users without a directory fallback', async () => {
    fetch.mockResolvedValue(reply({ users: [] }));
    expect(await searchUsers('   ', crypto.randomUUID())).toEqual([]);
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:5000/api/users?q=');
    expect(await searchUsers('unregistered', crypto.randomUUID())).toEqual([]);
  });

  it('retains the existing array response compatibility', async () => {
    fetch.mockResolvedValue(reply([{ userId: 'a', username: 'alice', online: false }]));
    expect(await searchUsers('ali', crypto.randomUUID())).toEqual([{ id: 'a', username: 'alice',
      displayName: 'alice', statusMessage: null, online: false }]);
  });

  it.each([
    [401, 'Authentication required.'],
    [400, 'Use a single q parameter of at most 64 characters without control characters.'],
    [500, 'Internal server error.'],
  ])('recognizes the safe backend error contract for HTTP %i', async (status, message) => {
    fetch.mockResolvedValue(reply({ status: 'error', message }, status));
    await expect(searchUsers('ali', crypto.randomUUID())).rejects.toThrow(message);
  });

  it('uses a controlled network error instead of exposing transport details', async () => {
    const privateValue = crypto.randomUUID();
    fetch.mockRejectedValue(new Error(privateValue));
    await expect(searchUsers('ali', crypto.randomUUID())).rejects.toThrow('Cannot reach the server. Check your connection and try again.');
  });

  it.each([
    [401, 'AUTH_EXPIRED', 'Authentication required.'],
    [400, 'INVALID_INPUT', 'Invalid request.'],
    [500, 'INTERNAL_ERROR', 'Internal server error.'],
  ])('reads CHATAPP-21 additive codes without changing HTTP %i messages', async (status, code, message) => {
    fetch.mockResolvedValue(reply({ status: 'error', code, message }, status));
    await expect(searchUsers('ali', crypto.randomUUID())).rejects.toThrow(message);
  });
});
