import { describe, expect, it } from 'vitest';
import { normalizeMessage, toIso } from './messages.js';

describe('normalizeMessage', () => {
  it('maps the SAD payload fields (userId, text)', () => {
    const m = normalizeMessage({ userId: 101, text: 'Hello team!', roomId: 'room-5', timestamp: 1694250000 });
    expect(m.from).toBe('101');
    expect(m.content).toBe('Hello team!');
    expect(m.roomId).toBe('room-5');
    expect(m.timestamp).toBe(new Date(1694250000 * 1000).toISOString());
  });

  it('falls back to defaults when the acknowledgement is sparse', () => {
    const m = normalizeMessage({}, { from: 'me', to: 'u1', content: 'hi' });
    expect(m.from).toBe('me');
    expect(m.content).toBe('hi');
  });
});

describe('toIso', () => {
  it('accepts milliseconds and ISO strings, and ignores bad input', () => {
    expect(toIso(1694250000000)).toBe(new Date(1694250000000).toISOString());
    expect(toIso('2026-10-23T10:00:00.000Z')).toBe('2026-10-23T10:00:00.000Z');
    expect(toIso('nonsense')).toBeUndefined();
  });
});
