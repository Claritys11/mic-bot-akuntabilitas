import { describe, expect, test } from 'bun:test';
import { balance, paidStatus, periodKey, periodLabel, periodRange, reversalOf, toCsv } from '../src/core/kas/ledger.ts';
import { verifyProof } from '../src/core/kas/verify.ts';
import type { LedgerEntry } from '../src/core/kas/ledger.ts';

const d = (s: string) => new Date(s);

describe('periode kas', () => {
  test('bulanan', () => {
    expect(periodKey(d('2026-10-22T03:00:00Z'), 'bulanan')).toBe('2026-10');
    // 31 Okt 23:30 WIB = 31 Okt 16:30Z → masih Oktober
    expect(periodKey(d('2026-10-31T16:30:00Z'), 'bulanan')).toBe('2026-10');
    // 1 Nov 00:30 WIB = 31 Okt 17:30Z → sudah November
    expect(periodKey(d('2026-10-31T17:30:00Z'), 'bulanan')).toBe('2026-11');
  });

  test('mingguan (ISO week, Senin)', () => {
    expect(periodKey(d('2026-10-22T03:00:00Z'), 'mingguan')).toBe('2026-W43');
    expect(periodKey(d('2026-10-25T16:00:00Z'), 'mingguan')).toBe('2026-W43'); // Minggu 23:00 WIB
    expect(periodKey(d('2026-10-25T17:30:00Z'), 'mingguan')).toBe('2026-W44'); // Senin 00:30 WIB
  });

  test('rentang periode', () => {
    const r = periodRange('2026-10');
    expect(r.start.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    const w = periodRange('2026-W43');
    expect(w.start.toISOString()).toBe('2026-10-18T17:00:00.000Z'); // Senin 19 Okt 00:00 WIB
    expect(periodLabel('2026-10')).toBe('Oktober 2026');
  });
});

const tx = (p: Partial<LedgerEntry>): LedgerEntry => ({
  id: Math.random().toString(36).slice(2),
  memberId: 'u1',
  memberName: 'Ani',
  amount: 10000,
  kind: 'iuran',
  period: '2026-10',
  createdAt: d('2026-10-10T00:00:00Z'),
  ...p,
});

describe('ledger', () => {
  test('saldo = jumlah semua entri (koreksi = entri negatif)', () => {
    const a = tx({ amount: 10000 });
    const entries = [a, tx({ memberId: 'u2', amount: 10000 }), reversalOf(a, 'salah input', 'admin', d('2026-10-11T00:00:00Z'))];
    expect(balance(entries)).toBe(10000);
  });

  test('reversal menandai entri asal', () => {
    const a = tx({ amount: 25000 });
    const r = reversalOf(a, 'dobel', 'admin', d('2026-10-11T00:00:00Z'));
    expect(r.amount).toBe(-25000);
    expect(r.reversalOf).toBe(a.id);
    expect(r.kind).toBe('koreksi');
  });

  test('status lunas per anggota di periode', () => {
    const members = [
      { id: 'u1', name: 'Ani' },
      { id: 'u2', name: 'Budi' },
      { id: 'u3', name: 'Caca' },
    ];
    const a = tx({ memberId: 'u1', amount: 10000 });
    const entries = [
      a,
      tx({ memberId: 'u2', amount: 5000 }),
      tx({ memberId: 'u3', amount: 10000 }),
      reversalOf(tx({ memberId: 'u3', amount: 10000, id: 'x' }), 'batal', 'admin', d('2026-10-12T00:00:00Z')),
      tx({ memberId: 'u2', amount: 10000, period: '2026-09' }),
    ];
    const s = paidStatus(members, entries, 10000, '2026-10');
    expect(s.paid.map((m) => m.id)).toEqual(['u1']);
    expect(s.unpaid.map((m) => [m.id, m.paidAmount])).toEqual([
      ['u2', 5000],
      ['u3', 0],
    ]);
  });

  test('ekspor CSV aman untuk koma & kutip', () => {
    const csv = toCsv([tx({ memberName: 'Ani, "si bendahara"', note: 'ok' })]);
    expect(csv.split('\n')[0]).toBe('tanggal,anggota,jenis,periode,nominal,catatan,id');
    expect(csv).toContain('"Ani, ""si bendahara"""');
  });
});

describe('verifikasi bukti transfer (realistis, bukan forensik)', () => {
  const base = {
    nominal: 10000,
    tanggal: '2026-10-21',
    refId: 'ABC123',
    imageHash: 'h1',
  };
  const ctx = {
    now: d('2026-10-22T03:00:00Z'),
    amount: 10000,
    period: 'bulanan' as const,
    seenHashes: new Set<string>(),
    seenRefIds: new Set<string>(),
  };

  test('bukti bersih → tanpa flag', () => {
    expect(verifyProof(base, ctx)).toEqual([]);
  });

  test('gambar duplikat', () => {
    expect(verifyProof(base, { ...ctx, seenHashes: new Set(['h1']) })).toContain('duplicate_image');
  });

  test('refId duplikat', () => {
    expect(verifyProof(base, { ...ctx, seenRefIds: new Set(['abc123']) })).toContain('duplicate_ref');
  });

  test('nominal tidak cocok iuran', () => {
    expect(verifyProof({ ...base, nominal: 7000 }, ctx)).toContain('amount_mismatch');
    expect(verifyProof({ ...base, nominal: 20000 }, ctx)).toEqual([]); // bayar 2 periode sekaligus
    expect(verifyProof({ ...base, nominal: null }, ctx)).toContain('amount_unreadable');
  });

  test('tanggal di luar periode / masa depan', () => {
    expect(verifyProof({ ...base, tanggal: '2026-08-01' }, ctx)).toContain('date_out_of_period');
    expect(verifyProof({ ...base, tanggal: '2026-10-25' }, ctx)).toContain('date_in_future');
    expect(verifyProof({ ...base, tanggal: null }, ctx)).toContain('date_unreadable');
  });
});
