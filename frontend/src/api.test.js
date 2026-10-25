import { describe, expect, it } from 'vitest';
import { login, logout, register, searchUsers } from './api.js';

describe('mock api', () => {
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
