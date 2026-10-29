// ReconnectManager (SAD 3.3, CHAT-F-014, CHAT-NF-003).
// Owns the retry settings and turns connection events into one status for the UI:
// 'connecting' | 'connected' | 'reconnecting' | 'disconnected'.
// Socket.IO retries with exponential backoff using these settings.
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

export function createReconnectManager(socket, onStatus) {
  let timer = null;
  let missed = 0;
  let generation = 0; // lets answers that arrive after a stop or restart be ignored

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
      if (!socket.connected) return;
      socket.timeout(HEARTBEAT.timeoutMs).emit(HEARTBEAT.event, (err) => {
        if (mine !== generation) return;
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
    socket.timeout(HEARTBEAT.timeoutMs).emit(HEARTBEAT.event, (err) => {
      if (!err) startHeartbeat();
    });
  }

  socket.on('connect', () => {
    onStatus('connected');
    probe();
  });

  socket.on('disconnect', (reason) => {
    stopHeartbeat();
    // 'io server disconnect' means the server closed the connection on purpose (for example after
    // logout or an invalid token). Socket.IO does not retry in that case.
    if (reason === 'io server disconnect') onStatus('disconnected');
    else if (reason !== 'io client disconnect') onStatus('reconnecting');
  });

  socket.on('connect_error', () => onStatus('reconnecting'));
  socket.io.on('reconnect_attempt', () => onStatus('reconnecting'));

  // The browser often knows about a lost network before the socket does, which helps CHAT-NF-003.
  const handleOffline = () => onStatus('reconnecting');
  const handleOnline = () => {
    if (!socket.connected) socket.connect();
  };
  window.addEventListener('offline', handleOffline);
  window.addEventListener('online', handleOnline);

  return () => {
    stopHeartbeat();
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('online', handleOnline);
  };
}