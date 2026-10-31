import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconnectManager } from './reconnectManager.js';

// A stand-in for the Socket.IO client. While `answers` is true the server replies to every ping.
function fakeSocket() {
  const socket = {
    connected: true,
    answers: true,
    handlers: {},
    on(event, fn) {
      this.handlers[event] = fn;
    },
    off(event, fn) { if (this.handlers[event] === fn) delete this.handlers[event]; },
    io: { on: vi.fn(), off: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
    timeout() {
      return {
        emit: (_event, cb) => (socket.answers ? cb(null, { status: 'success' }) : cb(new Error('timeout'))),
      };
    },
  };
  return socket;
}

describe('ReconnectManager heartbeat (CHAT-NF-003)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restarts the connection after two missed answers in a row, within 10 seconds', () => {
    const socket = fakeSocket();
    const statuses = [];
    createReconnectManager(socket, (status) => statuses.push(status));

    socket.handlers.connect(); // connected, the first ping is answered, the heartbeat starts
    socket.answers = false; // the connection goes silent
    vi.advanceTimersByTime(4000);

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connected', 'reconnecting']);
  });

  it('does not restart the connection after a single missed answer', () => {
    const socket = fakeSocket();
    createReconnectManager(socket, () => {});

    socket.handlers.connect();
    socket.answers = false;
    vi.advanceTimersByTime(2000); // one miss
    socket.answers = true;
    vi.advanceTimersByTime(10000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('stays off when the server never answers pings, so it cannot cause reconnect loops', () => {
    const socket = fakeSocket();
    socket.answers = false;
    createReconnectManager(socket, () => {});

    socket.handlers.connect();
    vi.advanceTimersByTime(20000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('stops checking after cleanup', () => {
    const socket = fakeSocket();
    const stop = createReconnectManager(socket, () => {});

    socket.handlers.connect();
    stop();
    socket.answers = false;
    vi.advanceTimersByTime(20000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('backs off inactive authentication retries, deduplicates timers and stops after six attempts', () => {
    const socket = fakeSocket();
    socket.connected = false;
    socket.active = false;
    const statuses = [];
    const stop = createReconnectManager(socket, status => statuses.push(status));
    const failure = { data: { code: 'INTERNAL_ERROR' } };
    socket.handlers.connect_error(failure);
    socket.handlers.connect_error(failure);
    const online = window.addEventListener.mock.calls.find(([event]) => event === 'online')[1];
    online();
    for (const [index, delay] of [1000, 2000, 4000, 8000, 10000, 10000].entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(socket.connect).toHaveBeenCalledTimes(index);
      vi.advanceTimersByTime(1);
      expect(socket.connect).toHaveBeenCalledTimes(index + 1);
      socket.active = true;
      online();
      expect(socket.connect).toHaveBeenCalledTimes(index + 1);
      socket.active = false;
      socket.handlers.connect_error(failure);
    }
    online();
    vi.advanceTimersByTime(100000);
    expect(socket.connect).toHaveBeenCalledTimes(6);
    expect(statuses.at(-1)).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('cleanup cancels authentication retries and removes its listeners', () => {
    const socket = fakeSocket();
    socket.connected = false;
    socket.active = false;
    const stop = createReconnectManager(socket, vi.fn());
    socket.handlers.connect_error({ data: { code: 'INTERNAL_ERROR' } });
    stop();
    vi.advanceTimersByTime(20000);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.handlers).toEqual({});
    expect(socket.io.off).toHaveBeenCalledWith('reconnect_attempt', expect.any(Function));
    expect(window.removeEventListener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_EXPIRED', 'AUTH_REVOKED'])('cancels a scheduled retry on %s', code => {
    const socket = fakeSocket();
    socket.connected = false;
    socket.active = false;
    const ended = vi.fn();
    const stop = createReconnectManager(socket, vi.fn(), ended);
    socket.handlers.connect_error({ data: { code: 'INTERNAL_ERROR' } });
    socket.handlers.connect_error({ data: { code } });
    vi.advanceTimersByTime(20000);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledWith(code);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});
