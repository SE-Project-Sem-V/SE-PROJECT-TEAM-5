import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./config.js', async original => ({ ...await original(), USE_MOCK: false, API_URL: 'http://localhost:5000' }));
import { getMyProfile, updateMyProfile, login } from './api.js';

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());
const user = { id: 'user-a', username: 'Alice', display_name: 'Alice 🐱', status_message: 'Available' };
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

describe('profile HTTP adapter', () => {
  it('loads the profile using a bearer header and an explicit public-field mapping', async () => {
    const secret = crypto.randomUUID();
    fetch.mockResolvedValue(reply({ user: { ...user, password_hash: secret, email: secret, token: secret, session_id: secret } }));
    const profile = await getMyProfile('current-token');
    expect(profile).toEqual({ id: 'user-a', username: 'Alice', displayName: 'Alice 🐱', statusMessage: 'Available', online: null });
    expect(JSON.stringify(profile)).not.toContain(secret);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:5000/api/users/me');
    expect(options.headers.Authorization).toBe('Bearer current-token');
    expect(options.method).toBe('GET');
  });
  it('sends partial patches and retains safe auth error codes', async () => {
    fetch.mockResolvedValueOnce(reply({ user: { ...user, status_message: null } }));
    expect((await updateMyProfile({ statusMessage: '' }, 'token')).statusMessage).toBeNull();
    const options = fetch.mock.calls[0][1];
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ statusMessage: '' });
    fetch.mockResolvedValue(reply({ code: 'AUTH_REVOKED', message: 'Session ended.' }, 401));
    await expect(getMyProfile('token')).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
  });
  it('keeps the database display name and canonical username at login', async () => {
    fetch.mockResolvedValue(reply({ token: 'session', user }));
    const result = await login('alice', 'temporary-test-input');
    expect(result.user.username).toBe('Alice');
    expect(result.user.displayName).toBe('Alice 🐱');
  });
});
