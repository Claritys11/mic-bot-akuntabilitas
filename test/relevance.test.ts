import { describe, expect, test } from 'bun:test';
import { relevance, pickNextOpportunity } from '../src/core/opps/relevance.ts';

const NOW = new Date('2026-10-22T03:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86400_000);
const opp = (id: string, tags: string[], deadlineDays: number) => ({ id, tags, deadline: day(deadlineDays) });

describe('relevansi info lomba', () => {
  test('tag jurusan langsung paling tinggi', () => {
    expect(relevance(['rpl', 'web'], 'RPL')).toBeGreaterThan(relevance(['umum'], 'RPL'));
    expect(relevance(['tkj', 'jaringan'], 'RPL')).toBe(0);
    expect(relevance(['ctf'], 'TKJ')).toBeGreaterThan(0);
    expect(relevance(['umum'], 'TKJ')).toBeGreaterThan(0);
  });

  test('pilih yang relevan, belum diposting, deadline masih jauh', () => {
    const opps = [
      opp('a', ['tkj'], 30),
      opp('b', ['rpl', 'hackathon'], 2), // terlalu mepet
      opp('c', ['umum'], 20),
      opp('d', ['rpl', 'web'], 40),
      opp('e', ['rpl'], 10),
    ];
    // skor tertinggi dulu (d: rpl+web), lalu e, lalu c (umum)
    expect(pickNextOpportunity(opps, 'RPL', new Set(), NOW)?.id).toBe('d');
    expect(pickNextOpportunity(opps, 'RPL', new Set(['d']), NOW)?.id).toBe('e');
    expect(pickNextOpportunity(opps, 'RPL', new Set(['d', 'e']), NOW)?.id).toBe('c');
    expect(pickNextOpportunity(opps, 'RPL', new Set(['e', 'd', 'c']), NOW)).toBeNull();
  });
});
