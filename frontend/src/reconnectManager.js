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

export function createReconnectManager(socket, onStatus) {
  socket.on('connect', () => onStatus('connected'));

  socket.on('disconnect', (reason) => {
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
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('online', handleOnline);
  };
}
