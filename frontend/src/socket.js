import { io } from 'socket.io-client';
import { API_URL, EVENTS, USE_MOCK, assertSecureTransport } from './config.js';
import { normalizeMessage, normalizePresence } from './messages.js';
import { RECONNECT_OPTIONS, createReconnectManager } from './reconnectManager.js';
import { reportSessionFailure } from './session.js';

// Returns { sendMessage(target, text, clientId) -> Promise<message>, disconnect() }.
// target is a user id (one-to-one chat) or { roomId } (group chat).
// handlers: { onMessage(message), onStatus(status), onPresence(update) }
export function connectSocket(token, user, handlers) {
  return USE_MOCK ? mockConnection(user, handlers) : realConnection(token, user, handlers);
}

function ackError(res) {
  const e = res?.error;
  return (typeof e === 'string' ? e : e?.message) || res?.message || 'The server rejected the message.';
}

const targetPayload = (target) => (typeof target === 'string' ? { to: target } : target);

function realConnection(token, user, { onMessage, onStatus, onPresence }) {
  assertSecureTransport();
  onStatus('connecting');
  // The JWT goes in the handshake (SAD flow 1, step 3). Never log it.
  const socket = io(API_URL, { auth: { token }, ...RECONNECT_OPTIONS });
  const stopReconnectManager = createReconnectManager(socket, onStatus,
    (code) => reportSessionFailure(token, code));

  socket.on(EVENTS.RECEIVE, (raw) => onMessage(normalizeMessage(raw)));
  socket.on(EVENTS.PRESENCE, (raw) => {
    const update = normalizePresence(raw);
    if (update) onPresence?.(update);
  });

  return {
    sendMessage: (target, text, clientId) =>
      new Promise((resolve, reject) => {
        // The client never sends a timestamp: the server sets it (CHAT-F-010).
        // clientId lets the server spot a retry of a message it already stored.
        socket.timeout(5000).emit(EVENTS.SEND, { ...targetPayload(target), text, clientId }, (err, res) => {
          if (err) return reject(new Error('The server did not confirm the message. Try sending it again.'));
          if (res?.ok === false || res?.status === 'error') {
            const error = new Error(ackError(res));
            error.code = res.code || res.error?.code;
            reportSessionFailure(token, error.code);
            return reject(error);
          }
          return resolve(
            normalizeMessage(res?.message ?? res ?? {}, {
              from: user.id,
              to: typeof target === 'string' ? target : undefined,
              content: text,
            }),
          );
        });
      }),
    disconnect: () => {
      stopReconnectManager();
      socket.disconnect();
    },
  };
}

function mockConnection(user, { onMessage, onStatus, onPresence }) {
  const timers = [];
  onStatus('connecting');
  timers.push(setTimeout(() => onStatus('connected'), 400));
  // Demo only: bob goes online and offline every 6 seconds so you can see the indicator change.
  let bobOnline = false;
  timers.push(
    setInterval(() => {
      bobOnline = !bobOnline;
      onPresence?.({ userId: 'u2', online: bobOnline });
    }, 6000),
  );

  return {
    sendMessage: (target, text) =>
      new Promise((resolve) => {
        const isGroup = typeof target !== 'string';
        timers.push(
          setTimeout(() => {
            const now = Date.now();
            resolve(
              normalizeMessage({
                id: `m-${now}`,
                userId: user.id,
                to: isGroup ? undefined : target,
                roomId: isGroup ? target.roomId : undefined,
                text,
                timestamp: now,
              }),
            );
            // Demo reply: in a group it comes from alice, in a chat from the person you wrote to.
            timers.push(
              setTimeout(
                () =>
                  onMessage(
                    normalizeMessage({
                      id: `m-${now}-reply`,
                      userId: isGroup ? 'u1' : target,
                      to: isGroup ? undefined : user.id,
                      roomId: isGroup ? target.roomId : undefined,
                      text: `Echo: ${text}`,
                      timestamp: Date.now(),
                    }),
                  ),
                700,
              ),
            );
          }, 200),
        );
      }),
    disconnect: () => timers.forEach(clearTimeout),
  };
}
