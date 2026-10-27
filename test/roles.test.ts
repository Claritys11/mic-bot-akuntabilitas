import { describe, expect, test } from 'bun:test';
import { can, rolesOf } from '../src/core/team/roles.ts';

const g = { roles: { ketua: ['k'], bendahara: ['b'], sekretaris: ['s'] }, kas: { treasurerId: 't', reviewerIds: ['r'] } } as never;
const as = (id: string, isAdmin = false) => ({ isAdmin, actor: { platformUserId: id } });

describe('peran tim inti', () => {
  test('bendahara utama lama (treasurerId) dihitung sebagai bendahara', () => {
    expect(rolesOf(g, 't')).toEqual(['bendahara']);
  });
  test.each([
    ['k', 'kelola', true],
    ['k', 'kas', false],
    ['k', 'lomba', true],
    ['b', 'kas', true],
    ['b', 'kelola', false],
    ['t', 'kas', true],
    ['r', 'kas', true],
    ['s', 'lomba', true],
    ['s', 'kas', false],
    ['x', 'lomba', false],
  ] as const)('%s → %s = %p', (id, ability, want) => {
    expect(can(g, as(id), ability)).toBe(want);
  });
  test('admin server boleh semua', () => {
    expect(can(g, as('x', true), 'kas')).toBe(true);
  });
});
