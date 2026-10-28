import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ on: vi.fn(), timeout: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => transport) }));
vi.mock('./config.js', async (importOriginal) => ({
  ...await importOriginal(), USE_MOCK: false, API_URL: 'http://localhost:5000',
}));
vi.mock('./reconnectManager.js', () => ({ RECONNECT_OPTIONS: {}, createReconnectManager: () => vi.fn() }));

import { connectSocket } from './socket.js';

beforeEach(() => {
  vi.clearAllMocks();
  transport.timeout.mockReturnValue(transport);
});
afterEach(() => vi.restoreAllMocks());

function connection(response, timeoutError = null) {
  transport.emit.mockImplementation((_event, _payload, callback) => callback(timeoutError, response));
  return connectSocket(crypto.randomUUID(), { id: 'sender' }, { onMessage: vi.fn(), onStatus: vi.fn() });
}

describe('CHATAPP-21 real socket adapter compatibility', () => {
  it.each([
    { ok: false, error: 'Message rejected.' },
    { ok: false, code: 'ROOM_FORBIDDEN', message: 'Message rejected.', error: 'Message rejected.' },
    { ok: false, error: { code: 'ROOM_FORBIDDEN', message: 'Message rejected.' } },
  ])('retains readable messages for legacy, additive and object errors', async (response) => {
    await expect(connection(response).sendMessage('recipient', 'hello', 'client-id')).rejects.toThrow('Message rejected.');
  });

  it('normalizes the unchanged successful persisted-message ACK and sends the same payload', async () => {
    const message = { id: 'saved-id', userId: 'sender', to: 'recipient', roomId: 'room',
      text: 'hello', timestamp: '2026-10-28T10:00:00.000Z' };
    const conn = connection({ ok: true, message });
    expect(await conn.sendMessage('recipient', 'hello', 'client-id')).toEqual({
      id: 'saved-id', from: 'sender', to: 'recipient', roomId: 'room', content: 'hello', timestamp: message.timestamp,
    });
    expect(transport.emit).toHaveBeenCalledWith('sendMessage',
      { to: 'recipient', text: 'hello', clientId: 'client-id' }, expect.any(Function));
  });

  it('keeps transport timeouts distinct and conceals their private details', async () => {
    const privateValue = crypto.randomUUID();
    await expect(connection(undefined, new Error(privateValue)).sendMessage('recipient', 'hello', 'client-id'))
      .rejects.toThrow('The server did not confirm the message. Try sending it again.');
  });
});
