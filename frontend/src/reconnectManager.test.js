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
    io: { on() {} },
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
});