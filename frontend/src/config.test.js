import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSecureTransport } from './config.js';
import { io } from 'socket.io-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('API endpoint configuration', () => {
  it('defaults to the local backend port when no URL is configured', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.resetModules();
    expect((await import('./config.js')).API_URL).toBe('http://localhost:5000');
  });

  it('honors an explicit deployment URL', async () => {
    vi.stubEnv('VITE_API_URL', 'https://chat.example.com/');
    vi.resetModules();
    expect((await import('./config.js')).API_URL).toBe('https://chat.example.com');
  });
});

describe('assertSecureTransport (PRJ-SR-001)', () => {
  it('allows plain http on localhost', () => {
    expect(() => assertSecureTransport('http://localhost:3000')).not.toThrow();
  });

  it('allows https on any host', () => {
    expect(() => assertSecureTransport('https://chat.example.com')).not.toThrow();
  });

  it('rejects plain http on a non-local host', () => {
    expect(() => assertSecureTransport('http://chat.example.com')).toThrow(/HTTPS/);
  });

  it.each(['http://127.0.0.1:5000', 'http://[::1]:5000', 'http://LOCALHOST:5000'])('allows explicit loopback development: %s', (url) => {
    expect(() => assertSecureTransport(url)).not.toThrow();
  });

  it.each([
    'ws://localhost:5000', 'wss://chat.example.com', 'ftp://localhost',
    'javascript:alert(1)', '/api', 'not a URL', 'http://localhost.evil.example',
    'http://localhost@evil.example', 'http://evil.example@localhost', 'http://@localhost',
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://%6cocalhost',
    'http://localhost.', 'http://localhost\\@evil.example', ' http://localhost',
    'https://user:password@chat.example.com', 'https://chat.example.com/?token=private',
    'https://chat.example.com/#private',
  ])('rejects unsupported, malformed or deceptive configuration: %s', (url) => {
    expect(() => assertSecureTransport(url)).toThrow(/HTTPS/);
  });

  it('requires HTTPS in production even for a loopback backend', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() => assertSecureTransport(`http://${host}:5000`)).toThrow(/HTTPS/);
    }
    expect(() => assertSecureTransport('https://chat.example.com')).not.toThrow();
  });

  it('does not allow a non-development mode to opt into local HTTP', () => {
    vi.stubEnv('MODE', 'staging');
    expect(() => assertSecureTransport('http://localhost:5000')).toThrow(/HTTPS/);
  });

  it('validates URLs consistently with the actual Socket.IO parser on an HTTP page', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173',
      hostname: 'localhost', port: '5173' });
    const sockets = [];
    function validatedSocket(url) {
      assertSecureTransport(url);
      const socket = io(url, { autoConnect: false, forceNew: true });
      sockets.push(socket);
      return socket;
    }
    try {
      for (const url of ['HTTPS://chat.example.invalid', 'Https://chat.example.invalid',
        'HTTP://localhost:5000', 'Http://127.0.0.1:5000']) {
        expect(() => validatedSocket(url)).toThrow(/HTTPS/);
      }
      for (const url of ['https://chat.example.invalid', 'http://localhost:5000',
        'http://127.0.0.1:5000', 'http://[::1]:5000']) {
        const socket = validatedSocket(url);
        // io() executes the installed URL parser even with autoConnect=false.
        // No mock or network connection is involved.
        expect(socket.io.uri).toBe(url);
        expect(new URL(socket.io.uri).protocol).toBe(new URL(url).protocol);
        expect(socket.nsp).toBe('/');
      }
    } finally {
      sockets.forEach(socket => socket.disconnect());
      vi.unstubAllGlobals();
    }
  });
});
