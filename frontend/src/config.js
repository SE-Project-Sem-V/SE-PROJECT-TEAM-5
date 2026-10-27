export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');
export const MAX_MESSAGE_LENGTH = Number(import.meta.env.VITE_MAX_MESSAGE_LENGTH) || 1000;

// Socket event names from SAD section 4.3. If the team agrees different names, change them only here.
export const EVENTS = { SEND: 'sendMessage', RECEIVE: 'newMessage', PRESENCE: 'presenceUpdate' };

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// PRJ-SR-001: non-local traffic must use HTTPS/WSS. Plain http/ws is allowed only on localhost.
export function assertSecureTransport(url = API_URL) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'https:' && !LOCAL_HOSTS.includes(hostname)) {
    throw new Error('Non-local traffic must use HTTPS/WSS. Set VITE_API_URL to an https:// address.');
  }
}
