import { describe, expect, test } from 'bun:test';
import { catalog, customSourceId, isEnabled, visibleTo } from '../src/core/opps/sources.ts';

const g = { groupId: 'A', lombaSources: { disabled: ['indbeasiswa'], custom: [] } } as never;

describe('katalog sumber lomba', () => {
  test('bawaan + tambahan operator, tanpa duplikat', () => {
    const c = catalog(['https://www.lombasma.com/feed', 'https://contoh.id/feed']);
    expect(c.map((s) => s.id)).toEqual(['lombasma', 'indbeasiswa', expect.stringMatching(/^env-/)]);
  });
  test('sumber yang dimatikan kelas tidak tampil; info kelas lain tidak pernah tampil', () => {
    expect(isEnabled(g, 'lombasma')).toBe(true);
    expect(visibleTo(g, { groupId: null, sourceId: 'lombasma' })).toBe(true);
    expect(visibleTo(g, { groupId: null, sourceId: 'indbeasiswa' })).toBe(false);
    expect(visibleTo(g, { groupId: null, sourceId: null })).toBe(true); // seed / manual global
    expect(visibleTo(g, { groupId: 'A', sourceId: 'custom-x' })).toBe(true);
    expect(visibleTo(g, { groupId: 'B', sourceId: 'custom-x' })).toBe(false);
  });
  test('ID sumber custom stabil', () => {
    expect(customSourceId('https://a.id/feed')).toBe(customSourceId('https://a.id/feed'));
  });
});
