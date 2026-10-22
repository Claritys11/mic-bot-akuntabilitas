import { describe, expect, test } from 'bun:test';
import { billingText, TEMPLATES } from '../src/core/billing/templates.ts';

const vars = { nama: '{{@u1}}', tugas: 'bikin PPT', deadline: 'Jumat, 23 Okt 20:00 WIB' };

describe('template tagihan unggah-ungguh', () => {
  test('setiap tingkat tutur × tahap punya ≥ 3 variasi', () => {
    for (const level of ['santai', 'sopan', 'krama'] as const) {
      for (const stage of ['h2', 'h1', 'h0', 'overdue'] as const) {
        expect(TEMPLATES[level][stage].length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('placeholder terisi semua', () => {
    for (const level of ['santai', 'sopan', 'krama'] as const) {
      for (const stage of ['h2', 'h1', 'h0', 'overdue'] as const) {
        for (let i = 0; i < 5; i++) {
          const t = billingText(level, stage, vars, `seed${i}`);
          expect(t).not.toMatch(/\{(nama|tugas|deadline)\}/);
          expect(t).toContain('bikin PPT');
        }
      }
    }
  });

  test('variasi deterministik per seed, berbeda antar seed', () => {
    const a = billingText('sopan', 'h2', vars, 'p1:h2');
    expect(billingText('sopan', 'h2', vars, 'p1:h2')).toBe(a);
    const all = new Set(Array.from({ length: 20 }, (_, i) => billingText('sopan', 'h2', vars, `p${i}:h2`)));
    expect(all.size).toBeGreaterThan(1);
  });
});
