import { describe, expect, test } from 'bun:test';
import { inQuietHours } from '../src/core/quiet.ts';

const wib = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 27, h - 7, m));

describe('jam tenang', () => {
  test.each([
    [20, false],
    [21, true],
    [23, true],
    [0, true],
    [5, true],
    [6, false],
    [12, false],
  ])('default 21–06, jam %p → %p', (h, want) => {
    expect(inQuietHours(wib(h), null)).toBe(want);
  });
  test('rentang tanpa melewati tengah malam', () => {
    expect(inQuietHours(wib(13), { start: 12, end: 14 })).toBe(true);
    expect(inQuietHours(wib(14), { start: 12, end: 14 })).toBe(false);
  });
  test('dimatikan → tidak pernah tenang', () => {
    expect(inQuietHours(wib(23), { enabled: false })).toBe(false);
  });
});
