export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');
export const MAX_MESSAGE_LENGTH = Number(import.meta.env.VITE_MAX_MESSAGE_LENGTH) || 1000;

// Socket event names from SAD section 4.3. If the team agrees different names, change them only here.
export const EVENTS = { SEND: 'sendMessage', RECEIVE: 'newMessage', PRESENCE: 'presenceUpdate' };

// API_URL is shared by fetch and Socket.IO, so use an HTTP(S) base URL.
// Match the original authority too: URL parsing normalizes deceptive forms
// such as 127.1, numeric IPs and percent-encoded localhost names.
export function assertSecureTransport(url = API_URL) {
  const failure = () => { throw new Error('Use an HTTPS backend URL. HTTP is allowed only for loopback development/test.'); };
  if (typeof url !== 'string' || /[\s\\]/u.test(url)) return failure();
  let parsed;
  try { parsed = new URL(url); } catch { return failure(); }
  // Socket.IO's scheme parser is case-sensitive. Reject noncanonical casing
  // instead of accepting a URL that fetch and Socket.IO interpret differently.
  const authority = /^https?:\/\/([^/?#]+)/.exec(url)?.[1];
  if (!authority || authority.includes('@') || parsed.username || parsed.password || parsed.search || parsed.hash) return failure();
  if (parsed.protocol === 'https:') return;
  const localDevelopment = !import.meta.env.PROD && ['development', 'test'].includes(import.meta.env.MODE);
  if (parsed.protocol !== 'http:' || !localDevelopment ||
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)) return failure();
}
