import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSecureTransport } from './config.js';

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
});
