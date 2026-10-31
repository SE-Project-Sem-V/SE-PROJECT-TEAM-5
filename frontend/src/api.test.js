import { describe, expect, it } from 'vitest';
import { getMyProfile, updateMyProfile, login, logout, register, searchUsers } from './api.js';

describe('mock api', () => {
  it('keeps mock profile fields consistent through registration, partial edits and relogin', async () => {
    const session = await register('profile_demo', 'temporary-test-input', 'Demo display');
    expect(session.user.displayName).toBe('Demo display');
    expect((await getMyProfile(session.token)).displayName).toBe('Demo display');
    await updateMyProfile({ statusMessage: 'Demo status' }, session.token);
    expect((await login('profile_demo', 'temporary-test-input')).user.statusMessage).toBe('Demo status');
    const cleared = await updateMyProfile({ statusMessage: '' }, session.token);
    expect(cleared.statusMessage).toBeNull();
    expect(cleared.displayName).toBe('Demo display');
  });
  it('registers a user and returns a token', async () => {
    const result = await register('maansi', 'secret1');
    expect(result.token).toBeTruthy();
    expect(result.user.username).toBe('maansi');
  });

  it('logs in with a password', async () => {
    const result = await login('maansi', 'secret1');
    expect(result.user.username).toBe('maansi');
  });

  it('rejects login without a password', async () => {
    await expect(login('maansi', '')).rejects.toThrow(/password/i);
  });

  it('filters users by search text', async () => {
    const users = await searchUsers('ali', 'token');
    expect(users.map((u) => u.username)).toEqual(['alice']);
  });

  it('matches trimmed mixed-case text and leaves empty searches empty', async () => {
    expect((await searchUsers(' ALI ', 'token')).map((u) => u.username)).toEqual(['alice']);
    expect(await searchUsers('   ', 'token')).toEqual([]);
  });

  it('logs out without error', async () => {
    await expect(logout('token')).resolves.toBeUndefined();
  });
});
