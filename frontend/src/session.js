const terminalCodes = new Set(['AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_EXPIRED', 'AUTH_REVOKED']);
const listeners = new Set();

export const isSessionFailure = (code) => terminalCodes.has(code);

export function onSessionFailure(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportSessionFailure(token, code) {
  if (!token || !isSessionFailure(code)) return;
  for (const listener of listeners) {
    try { listener({ token, code }); } catch { /* notification must not mask the request error */ }
  }
}

export function apiError(status, data, token) {
  const detail = data.error;
  const message = (typeof detail === 'string' ? detail : detail?.message) || data.message ||
    (status === 401 ? 'Incorrect username or password.' : status === 400 ?
      'The request was not valid. Check what you entered.' : `Something went wrong (error ${status}). Try again.`);
  const error = new Error(message);
  error.code = data.code || detail?.code;
  reportSessionFailure(token, error.code);
  return error;
}

export function createSessionGuard(token = null) {
  let current = token;
  let generation = 0;
  return {
    setToken(next) { current = next; generation += 1; },
    isCurrent(value) { return Boolean(value) && value === current; },
    capture() { const mine = generation; return () => generation === mine; },
  };
}
