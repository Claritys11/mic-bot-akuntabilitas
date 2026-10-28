import { describe, expect, test } from 'bun:test';
import type { LedgerEntry } from '../src/core/kas/ledger.ts';
import { buildKasSheet, spreadsheetIdOf } from '../src/core/kas/sheet.ts';

const d = (s: string) => new Date(s);
const e = (p: Partial<LedgerEntry>): LedgerEntry => ({ id: 'x', memberId: 'a', memberName: 'Ani', amount: 10000, kind: 'iuran', period: '2026-10', createdAt: d('2026-10-05T03:00:00Z'), ...p });

describe('isi Google Sheet kas', () => {
  const tabs = buildKasSheet({
    className: 'XI RPL 1',
    marker: 'MIC-ABC',
    amount: 10000,
    period: 'bulanan',
    now: d('2026-10-27T13:00:00Z'),
    members: [
      { id: 'a', name: 'Ani' },
      { id: 'b', name: 'Budi' },
    ],
    entries: [
      e({}),
      e({ id: 'y', memberId: 'b', memberName: 'Budi', amount: 5000, createdAt: d('2026-10-06T03:00:00Z') }),
      e({ id: 'z', memberId: null, memberName: 'Beli spidol', amount: -7000, kind: 'pengeluaran', createdAt: d('2026-10-07T03:00:00Z'), note: 'nota' }),
    ],
    proofs: [{ createdAt: d('2026-10-05T02:00:00Z'), memberName: 'Ani', nominal: 10000, period: '2026-10', status: 'approved', flags: ['recipient_mismatch'] }],
    flagText: (f) => `[${f}]`,
    audits: [{ at: d('2026-10-05T03:00:00Z'), actorName: 'Sari', action: 'kas.setujui', detail: 'Ani Rp10.000 (Oktober 2026)' }],
  });
  const tab = (t: string) => tabs.find((x) => x.title === t)!.rows;

  test('empat tab dengan header', () => {
    expect(tabs.map((t) => t.title)).toEqual(['Ringkasan', 'Buku Kas', 'Status Iuran', 'Bukti Transfer', 'Jejak Audit']);
    expect(tab('Jejak Audit')[1]).toEqual(['2026-10-05 10:00', 'Sari', 'Setujui bukti', 'Ani Rp10.000 (Oktober 2026)']);
  });
  test('ringkasan: saldo, masuk, keluar, lunas/belum', () => {
    const r = Object.fromEntries(tab('Ringkasan').filter((x) => x.length === 2));
    expect(r).toMatchObject({ Saldo: 8000, 'Total masuk': 15000, 'Total pengeluaran': 7000, 'Sudah lunas periode ini': '1 dari 2 anggota' });
    expect(tab('Ringkasan')[0]).toEqual(['Laporan Kas XI RPL 1']);
  });
  test('buku kas: saldo berjalan & pengeluaran di kolom Keluar', () => {
    expect(tab('Buku Kas').slice(1).map((r) => [r[1], r[4], r[5], r[6]])).toEqual([
      ['Ani', 10000, '', 10000],
      ['Budi', 5000, '', 15000],
      ['Beli spidol', '', 7000, 8000],
    ]);
  });
  test('status iuran: 6 periode terakhir + status sekarang', () => {
    const rows = tab('Status Iuran');
    expect(rows[0]).toHaveLength(8);
    expect(rows[1]!.at(-1)).toBe('Lunas');
    expect(rows[2]!.at(-1)).toBe('Kurang Rp5.000');
  });
  test('bukti: status & catatan otomatis', () => {
    expect(tab('Bukti Transfer')[1]).toEqual(['2026-10-05 09:00', 'Ani', 10000, 'Oktober 2026', 'Disetujui', '• [recipient_mismatch]']);
  });
});

describe('penanda kelas di sheet', () => {
  test('stabil & berbeda antar kelas', async () => {
    const { sheetMarker } = await import('../src/core/kas/sheet.ts');
    expect(sheetMarker('discord', '1')).toBe(sheetMarker('discord', '1'));
    expect(sheetMarker('discord', '1')).not.toBe(sheetMarker('discord', '2'));
  });
});

describe('link spreadsheet', () => {
  test.each([
    ['https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x/edit#gid=0', '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x'],
    ['1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x', '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x'],
    ['https://example.com/x', null],
  ])('%p', (input, want) => expect(spreadsheetIdOf(input)).toBe(want));
});
