import { describe, expect, test } from 'bun:test';
import { parseRelativeDate } from '../src/core/promises/dateParser.ts';
import { formatWIB } from '../src/core/time.ts';

// Kamis, 22 Oktober 2026, 10:00 WIB
const NOW = new Date('2026-10-22T03:00:00Z');
const p = (s: string, now = NOW) => {
  const r = parseRelativeDate(s, now);
  return r ? formatWIB(r.date, 'iso') : null;
};

describe('jam tanpa hari → kemunculan terdekat ke depan (temuan holdout)', () => {
  const at = (iso: string) => new Date(iso);
  test('"jam 8" diucapkan 19.04 → 20.00 hari ini, bukan 08.00 yang sudah lewat', () => {
    expect(p('nanti tak kirim jam 8', at('2026-11-02T12:04:00Z'))).toBe('2026-11-02 20:00');
    expect(p('jam 8', at('2026-11-02T12:04:00Z'))).toBe('2026-11-02 20:00');
  });
  test('"jam 8" diucapkan 07.00 → 08.00 hari ini', () => {
    expect(p('jam 8 ya', at('2026-11-02T00:00:00Z'))).toBe('2026-11-02 08:00');
  });
  test('"jam 8" diucapkan 21.00 → 08.00 besok', () => {
    expect(p('jam 8', at('2026-11-02T14:00:00Z'))).toBe('2026-11-03 08:00');
  });
  test('bagian hari disebut → tidak ditebak ulang', () => {
    expect(p('jam 7 pagi', at('2026-11-02T12:04:00Z'))).toBe('2026-11-03 07:00');
    expect(p('nanti jam 9 malam', at('2026-11-02T12:04:00Z'))).toBe('2026-11-02 21:00');
  });
  test('hari disebut → jam dipakai apa adanya', () => {
    expect(p('besok jam 8', at('2026-11-02T12:04:00Z'))).toBe('2026-11-03 08:00');
  });
});

describe('bagian hari yang sedang berjalan (QA T18)', () => {
  const at = (iso: string) => new Date(iso);
  test('"nanti malam" diucapkan 20.27 → 23.00 malam ini (bukan 20.00 yang sudah lewat)', () => {
    expect(p('aku yang bikin rangkuman rumus nanti malam', at('2026-10-27T13:27:00Z'))).toBe('2026-10-27 23:00');
  });
  test('"nanti sore" diucapkan 17.00 → 18.00', () => {
    expect(p('nanti sore', at('2026-10-27T10:00:00Z'))).toBe('2026-10-27 18:00');
  });
  test('"nanti pagi" diucapkan 21.00 → besok pagi', () => {
    expect(p('nanti pagi', at('2026-10-27T14:00:00Z'))).toBe('2026-10-28 08:00');
  });
  test('belum lewat → jam biasa', () => {
    expect(p('nanti malam', at('2026-10-27T05:00:00Z'))).toBe('2026-10-27 20:00');
  });
});

describe('kosakata waktu Jawa', () => {
  test('sesuk / mengko bengi / sesuk esuk', () => {
    expect(p('tak garapne sesuk')).toBe('2026-10-23 20:00');
    expect(p('mengko bengi')).toBe('2026-10-22 20:00');
    expect(p('sesuk esuk')).toBe('2026-10-23 08:00');
  });
});

describe('parseRelativeDate (Asia/Jakarta)', () => {
  test('nama hari → kemunculan berikutnya, jam default 20:00', () => {
    expect(p('aku yang bikin PPT ya, Jumat jadi')).toBe('2026-10-23 20:00');
    expect(p("jum'at")).toBe('2026-10-23 20:00');
    expect(p('senin')).toBe('2026-10-26 20:00');
  });

  test('hari yang sama = hari ini', () => {
    expect(p('kamis')).toBe('2026-10-22 20:00');
  });

  test('"<hari> depan" = hari itu di minggu depan', () => {
    expect(p('jumat depan')).toBe('2026-10-30 20:00');
    expect(p('senin depan')).toBe('2026-10-26 20:00');
  });

  test('besok / lusa / hari ini dengan waktu', () => {
    expect(p('besok sore')).toBe('2026-10-23 16:00');
    expect(p('besok pagi')).toBe('2026-10-23 08:00');
    expect(p('lusa')).toBe('2026-10-24 20:00');
    expect(p('nanti malam')).toBe('2026-10-22 20:00');
    expect(p('hari ini jam 3 sore')).toBe('2026-10-22 15:00');
  });

  test('jam eksplisit', () => {
    expect(p('besok jam 7')).toBe('2026-10-23 07:00');
    expect(p('besok jam 7 malam')).toBe('2026-10-23 19:00');
    expect(p('kamis pukul 13.30')).toBe('2026-10-22 13:30');
    expect(p('besok jam 19:15')).toBe('2026-10-23 19:15');
  });

  test('tanggal', () => {
    expect(p('tgl 30')).toBe('2026-10-30 20:00');
    expect(p('tanggal 5')).toBe('2026-11-05 20:00'); // sudah lewat → bulan depan
    expect(p('30/10')).toBe('2026-10-30 20:00');
    expect(p('2 november')).toBe('2026-11-02 20:00');
    expect(p('10 okt')).toBe('2027-10-10 20:00'); // sudah lewat → tahun depan
  });

  test('minggu: hari Minggu vs pekan', () => {
    expect(p('minggu depan')).toBe('2026-10-29 20:00');
    expect(p('hari minggu')).toBe('2026-10-25 20:00');
    expect(p('seminggu lagi')).toBe('2026-10-29 20:00');
  });

  test('N hari lagi', () => {
    expect(p('3 hari lagi')).toBe('2026-10-25 20:00');
  });

  test('tidak ada tanggal → null', () => {
    expect(p('oke siap')).toBeNull();
    expect(p('aku yang bikin PPT')).toBeNull();
  });

  test('hasTime hanya true kalau waktu disebut', () => {
    expect(parseRelativeDate('besok', NOW)?.hasTime).toBe(false);
    expect(parseRelativeDate('besok sore', NOW)?.hasTime).toBe(true);
  });
});
