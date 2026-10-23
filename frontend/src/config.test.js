import { describe, expect, it } from 'vitest';
import { assertSecureTransport } from './config.js';

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
