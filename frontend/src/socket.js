import { io } from 'socket.io-client';
import { API_URL, EVENTS, USE_MOCK, assertSecureTransport } from './config.js';
import { normalizeMessage } from './messages.js';
import { RECONNECT_OPTIONS, createReconnectManager } from './reconnectManager.js';

// Returns { sendMessage(to, text, clientId) -> Promise<message>, disconnect() }.
// handlers: { onMessage(message), onStatus(status) }
export function connectSocket(token, user, handlers) {
  return USE_MOCK ? mockConnection(user, handlers) : realConnection(token, user, handlers);
}

function ackError(res) {
  const e = res?.error;
  return (typeof e === 'string' ? e : e?.message) || res?.message || 'The server rejected the message.';
}

function realConnection(token, user, { onMessage, onStatus }) {
  assertSecureTransport();
  onStatus('connecting');
  // The JWT goes in the handshake (SAD flow 1, step 3). Never log it.
  const socket = io(API_URL, { auth: { token }, ...RECONNECT_OPTIONS });
  const stopReconnectManager = createReconnectManager(socket, onStatus);

  socket.on(EVENTS.RECEIVE, (raw) => onMessage(normalizeMessage(raw)));

  return {
    sendMessage: (to, text, clientId) =>
      new Promise((resolve, reject) => {
        // The client never sends a timestamp: the server sets it (CHAT-F-010).
        // clientId lets the server spot a retry of a message it already stored.
        socket.timeout(5000).emit(EVENTS.SEND, { to, text, clientId }, (err, res) => {
          if (err) return reject(new Error('The server did not confirm the message. Try sending it again.'));
          if (res?.ok === false || res?.status === 'error') return reject(new Error(ackError(res)));
          return resolve(normalizeMessage(res?.message ?? res ?? {}, { from: user.id, to, content: text }));
        });
      }),
    disconnect: () => {
      stopReconnectManager();
      socket.disconnect();
    },
  };
}

function mockConnection(user, { onMessage, onStatus }) {
  const timers = [];
  onStatus('connecting');
  timers.push(setTimeout(() => onStatus('connected'), 400));

  return {
    sendMessage: (to, text) =>
      new Promise((resolve) => {
        timers.push(
          setTimeout(() => {
            const now = Date.now();
            resolve(normalizeMessage({ id: `m-${now}`, userId: user.id, to, text, timestamp: now }));
            timers.push(
              setTimeout(
                () => onMessage(normalizeMessage({ id: `m-${now}-reply`, userId: to, to: user.id, text: `Echo: ${text}`, timestamp: Date.now() })),
                700,
              ),
            );
          }, 200),
        );
      }),
    disconnect: () => timers.forEach(clearTimeout),
  };
}