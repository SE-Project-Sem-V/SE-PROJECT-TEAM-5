// ReconnectManager (SAD 3.3, CHAT-F-014, CHAT-NF-003).
// Owns the retry settings and turns connection events into one status for the UI:
// 'connecting' | 'connected' | 'reconnecting' | 'disconnected'.
// Socket.IO retries with exponential backoff using these settings.
import { isSessionFailure } from './session.js';

export const RECONNECT_OPTIONS = {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.5,
};

// CHAT-NF-003: the client must notice a dead connection within 10 seconds. Socket.IO alone relies on the
// server's ping settings (25 s + 20 s by default), which is too slow. So the client also checks the server
// itself: it sends "protected:ping" (the server answers it) every 2 s and treats 2 missed answers in a row
// (about 4 to 6 s) as a lost connection.
export const HEARTBEAT = { event: 'protected:ping', intervalMs: 2000, timeoutMs: 2000, maxMissed: 2 };
const AUTH_RETRY_ATTEMPTS = 6;

export function createReconnectManager(socket, onStatus, onAuthFailure = () => {}) {
  let timer = null;
  let missed = 0;
  let generation = 0; // lets answers that arrive after a stop or restart be ignored
  let terminal = false;
  let serverClosed = false;
  let authRetryTimer = null;
  let authRetryAttempts = 0;

  function cancelAuthRetry() {
    clearTimeout(authRetryTimer);
    authRetryTimer = null;
  }

  function retryAuthentication() {
    if (terminal || serverClosed || socket.connected || socket.active || authRetryTimer !== null) return;
    if (authRetryAttempts >= AUTH_RETRY_ATTEMPTS) return onStatus('disconnected');
    onStatus('reconnecting');
    const delay = Math.min(RECONNECT_OPTIONS.reconnectionDelay * 2 ** authRetryAttempts,
      RECONNECT_OPTIONS.reconnectionDelayMax);
    authRetryTimer = setTimeout(() => {
      authRetryTimer = null;
      if (terminal || serverClosed || socket.connected || socket.active) return;
      authRetryAttempts += 1;
      // Middleware rejection makes the namespace inactive; Manager retries cannot reactivate it.
      socket.connect();
    }, delay);
  }

  function endSession(code) {
    if (terminal || !isSessionFailure(code)) return;
    terminal = true;
    cancelAuthRetry();
    stopHeartbeat();
    socket.disconnect();
    onAuthFailure(code);
  }

  function stopHeartbeat() {
    clearInterval(timer);
    timer = null;
    missed = 0;
    generation += 1;
  }

  function startHeartbeat() {
    stopHeartbeat();
    const mine = generation;
    timer = setInterval(() => {
      if (!socket.connected || terminal) return;
      socket.timeout(HEARTBEAT.timeoutMs).emit(HEARTBEAT.event, (err, response) => {
        if (mine !== generation) return;
        if (isSessionFailure(response?.code)) return endSession(response.code);
        if (!err) {
          missed = 0;
          return;
        }
        missed += 1;
        if (missed >= HEARTBEAT.maxMissed) {
          // The connection looks dead: restart it. Socket.IO then retries with the backoff above.
          stopHeartbeat();
          onStatus('reconnecting');
          socket.disconnect();
          socket.connect();
        }
      });
    }, HEARTBEAT.intervalMs);
  }

  // Only turn the heartbeat on if the server answers it once, so a server without it never causes reconnect loops.
  function probe() {
    const mine = generation;
    socket.timeout(HEARTBEAT.timeoutMs).emit(HEARTBEAT.event, (err, response) => {
      if (terminal || mine !== generation) return;
      if (isSessionFailure(response?.code)) return endSession(response.code);
      if (!err) startHeartbeat();
    });
  }

  function handleConnect() {
    if (terminal) return socket.disconnect();
    cancelAuthRetry();
    authRetryAttempts = 0;
    stopHeartbeat();
    serverClosed = false;
    onStatus('connected');
    probe();
  }

  function handleDisconnect(reason) {
    cancelAuthRetry();
    stopHeartbeat();
    // 'io server disconnect' means the server closed the connection on purpose (for example after
    // logout or an invalid token). Socket.IO does not retry in that case.
    if (reason === 'io server disconnect') { serverClosed = true; onStatus('disconnected'); }
    else if (reason !== 'io client disconnect') onStatus('reconnecting');
  }

  function handleSessionEnded(data) { endSession(data?.code); }
  function handleConnectError(error) {
    if (isSessionFailure(error?.data?.code)) endSession(error.data.code);
    else if (!terminal && error?.data?.code === 'INTERNAL_ERROR' && socket.active === false) retryAuthentication();
    else if (!terminal) onStatus(socket.active === false ? 'disconnected' : 'reconnecting');
  }
  const handlers = { connect: handleConnect, disconnect: handleDisconnect,
    'auth:session-ended': handleSessionEnded, connect_error: handleConnectError };
  for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
  const handleReconnectAttempt = () => { if (!terminal && !serverClosed) onStatus('reconnecting'); };
  socket.io.on('reconnect_attempt', handleReconnectAttempt);

  // The browser often knows about a lost network before the socket does, which helps CHAT-NF-003.
  const handleOffline = () => { if (!terminal && !serverClosed) onStatus('reconnecting'); };
  const handleOnline = () => {
    if (socket.connected || socket.active || terminal || serverClosed || authRetryTimer !== null) return;
    if (authRetryAttempts > 0 && socket.active === false) retryAuthentication();
    else socket.connect();
  };
  window.addEventListener('offline', handleOffline);
  window.addEventListener('online', handleOnline);

  return () => {
    terminal = true;
    cancelAuthRetry();
    stopHeartbeat();
    for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    socket.io.off('reconnect_attempt', handleReconnectAttempt);
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('online', handleOnline);
  };
}
