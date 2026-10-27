import { describe, expect, test } from 'bun:test';
import { allocatePayment, paidStatus, rateFor, type LedgerEntry } from '../src/core/kas/ledger.ts';

const e = (period: string, amount: number, memberId = 'b'): LedgerEntry => ({ id: period, memberId, memberName: 'Budi', amount, kind: 'iuran', period, createdAt: new Date('2026-01-01') });

describe('riwayat tarif', () => {
  const rates = [
    { amount: 5000, period: 'bulanan' as const, from: '0000' },
    { amount: 10000, period: 'bulanan' as const, from: '2026-11' },
  ];
  test('periode lama pakai tarif lama, sejak berlaku pakai tarif baru', () => {
    expect(rateFor(rates, { amount: 10000, period: 'bulanan' }, '2026-10')).toBe(5000);
    expect(rateFor(rates, { amount: 10000, period: 'bulanan' }, '2026-11')).toBe(10000);
  });
  test('tanpa riwayat → tarif sekarang', () => {
    expect(rateFor([], { amount: 7000, period: 'bulanan' }, '2026-01')).toBe(7000);
  });
  test('yang dulu lunas Rp5.000 tetap lunas setelah iuran naik (bug lama)', () => {
    const rate = (p: string) => rateFor(rates, { amount: 10000, period: 'bulanan' }, p);
    expect(paidStatus([{ id: 'b', name: 'Budi' }], [e('2026-10', 5000)], rate, '2026-10').paid).toHaveLength(1);
  });
});

describe('alokasi pembayaran (FIFO)', () => {
  const base = { memberId: 'b', kasPeriod: 'bulanan' as const, rate: () => 10000, start: '2026-08', current: '2026-10' };
  test('rapel 30rb → bulan tertua yang belum lunas dulu', () => {
    expect(allocatePayment({ ...base, nominal: 30000, entries: [e('2026-09', 10000)] })).toEqual([
      { period: '2026-08', amount: 10000 },
      { period: '2026-10', amount: 10000 },
      { period: '2026-11', amount: 10000 },
    ]);
  });
  test('bayar sebagian → menutup sisa kekurangan bulan itu dulu', () => {
    expect(allocatePayment({ ...base, nominal: 15000, entries: [e('2026-08', 5000), e('2026-09', 10000), e('2026-10', 10000)] })).toEqual([
      { period: '2026-08', amount: 5000 },
      { period: '2026-11', amount: 10000 },
    ]);
  });
  test('bayar kurang dari iuran → tercatat sebagian', () => {
    expect(allocatePayment({ ...base, nominal: 4000, entries: [e('2026-08', 10000), e('2026-09', 10000)] })).toEqual([{ period: '2026-10', amount: 4000 }]);
  });
  test('lebih dari 12 periode ke depan → sisanya ditumpuk di periode terakhir (tidak hilang)', () => {
    const r = allocatePayment({ ...base, start: '2026-10', nominal: 200000, entries: [] });
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(200000);
    expect(r).toHaveLength(13);
  });
});
