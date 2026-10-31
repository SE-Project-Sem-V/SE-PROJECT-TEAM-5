import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, createSessionGuard, onSessionFailure } from './session.js';
import { createReconnectManager } from './reconnectManager.js';
import { logout } from './api.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AuthScreen from './components/AuthScreen.jsx';

vi.mock('./config.js', async (original) => ({ ...await original(),
  USE_MOCK: false, API_URL: 'http://localhost:5000' }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('CHATAPP-8 session cleanup', () => {
  it.each(['Signed out.', 'Signed out on this device. Server logout could not be confirmed.'])('renders logout feedback inside the visible login form: %s', (notice) => {
    const html = renderToStaticMarkup(createElement(AuthScreen, { onAuth: vi.fn(), notice }));
    const status = html.indexOf('data-testid="logout-status"');
    expect(status).toBeGreaterThan(html.indexOf('<form'));
    expect(status).toBeLessThan(html.indexOf('</form>'));
    expect(html).toContain(`role="status" data-testid="logout-status">${notice}</p>`);
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
  });

  it('posts logout using the existing bearer API contract', async () => {
    const token = crypto.randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));
    await logout(token);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:5000/api/auth/logout');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization === `Bearer ${token}`).toBe(true);
    expect(options.body).toBeUndefined();
  });

  it('propagates server logout failure rather than claiming remote invalidation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500,
      json: async () => ({ code: 'INTERNAL_ERROR', message: 'Internal server error.' }) }));
    await expect(logout(crypto.randomUUID())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('invalidates pending results on logout and on a new login', () => {
    const guard = createSessionGuard('session-a');
    const requestA = guard.capture();
    guard.setToken(null);
    expect(requestA()).toBe(false);
    const logoutRequest = guard.capture();
    guard.setToken('session-b');
    expect(logoutRequest()).toBe(false);
    expect(guard.isCurrent('session-a')).toBe(false);
    expect(guard.isCurrent('session-b')).toBe(true);
  });

  it('preserves public auth codes and scopes failure notifications to the requesting token', () => {
    const listener = vi.fn();
    const stop = onSessionFailure(listener);
    try {
      const error = apiError(401, { code: 'AUTH_REVOKED', message: 'Session ended.' }, 'session-a');
      expect(error.code).toBe('AUTH_REVOKED');
      expect(error.message).toBe('Session ended.');
      expect(listener).toHaveBeenCalledWith({ token: 'session-a', code: 'AUTH_REVOKED' });
      apiError(500, { code: 'INTERNAL_ERROR', message: 'Internal server error.' }, 'session-a');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  function connection() {
    vi.useFakeTimers();
    const browserEvents = {};
    vi.stubGlobal('window', { addEventListener: (event, callback) => { browserEvents[event] = callback; }, removeEventListener() {} });
    const handlers = {};
    const socket = { connected: false, on: (name, callback) => { handlers[name] = callback; },
      off: (name, callback) => { if (handlers[name] === callback) delete handlers[name]; },
      io: { on() {}, off() {} }, connect: vi.fn(), disconnect: vi.fn(),
      timeout: () => ({ emit: (_event, callback) => callback(null, { code: 'AUTH_EXPIRED', ok: false }) }) };
    const ended = vi.fn();
    createReconnectManager(socket, vi.fn(), ended);
    return { socket, handlers, browserEvents, ended };
  }

  it.each(['AUTH_REVOKED', 'AUTH_EXPIRED', 'AUTH_INVALID'])('stops reconnection and online retries for %s', (code) => {
    const f = connection();
    f.handlers.connect_error({ data: { code } });
    f.browserEvents.online();
    vi.advanceTimersByTime(20000);
    expect(f.socket.connect).not.toHaveBeenCalled();
    expect(f.ended).toHaveBeenCalledWith(code);
  });

  it('handles an authenticated session-ended event and heartbeat rejection', () => {
    const first = connection();
    first.handlers['auth:session-ended']({ code: 'AUTH_REVOKED' });
    expect(first.ended).toHaveBeenCalledWith('AUTH_REVOKED');
    const second = connection();
    second.handlers.connect();
    expect(second.ended).toHaveBeenCalledWith('AUTH_EXPIRED');
  });

  it('still permits ordinary network recovery', () => {
    const f = connection();
    f.handlers.connect_error(new Error('temporary network failure'));
    f.browserEvents.online();
    expect(f.socket.connect).toHaveBeenCalledOnce();
    expect(f.ended).not.toHaveBeenCalled();
  });
});
