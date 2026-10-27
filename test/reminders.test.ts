import { describe, expect, test } from 'bun:test';
import { looksLikeReminderRequest, parseReminderRequest } from '../src/core/reminders/parse.ts';
import { formatWIB } from '../src/core/time.ts';

// Senin, 2 Nov 2026 19:00 WIB
const NOW = new Date('2026-11-02T12:00:00Z');
const r = (t: string) => {
  const x = parseReminderRequest(t, NOW);
  return x && { ...x, at: x.at ? formatWIB(x.at, 'iso') : null };
};

describe('permintaan pengingat', () => {
  test('pengingat pribadi', () => {
    expect(r('@MIC ingetin aku besok jam 7 bawa proyektor')).toEqual({ target: 'self', what: 'bawa proyektor', at: '2026-11-03 07:00' });
  });
  test('pengingat untuk kelas', () => {
    expect(r('tolong ingatkan kita jumat soal iuran study tour')).toEqual({ target: 'group', what: 'iuran study tour', at: '2026-11-06 20:00' });
  });
  test('jam tanpa hari → kemunculan terdekat', () => {
    expect(r('ingetin aku jam 9 kumpulin tugas')).toEqual({ target: 'self', what: 'kumpulin tugas', at: '2026-11-02 21:00' });
  });
  test('tanpa waktu → at null (bot tanya kapan)', () => {
    expect(r('ingetin aku beli spidol')).toEqual({ target: 'self', what: 'beli spidol', at: null });
  });
  test('Jawa: elingke', () => {
    expect(r('elingke aku sesuk jam 6 pagi piket')).toEqual({ target: 'self', what: 'piket', at: '2026-11-03 06:00' });
  });
  test('bukan permintaan', () => {
    expect(looksLikeReminderRequest('aku inget kok')).toBe(false);
    expect(parseReminderRequest('besok libur ya', NOW)).toBeNull();
  });
});
