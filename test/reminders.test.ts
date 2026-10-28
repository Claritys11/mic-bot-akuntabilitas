import { describe, expect, test } from 'bun:test';
import { detectReminderOffer, looksLikeReminderRequest, parseReminderRequest } from '../src/core/reminders/parse.ts';
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
    // Tanpa jam → malam sebelumnya (acaranya bisa pagi).
    expect(r('tolong ingatkan kita jumat soal iuran study tour')).toEqual({ target: 'group', what: 'iuran study tour', at: '2026-11-05 19:00', lead: 'eve' });
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

describe('tawaran pengingat tanpa tag', () => {
  const o = (t: string) => {
    const x = detectReminderOffer(t, NOW);
    return x && { ...x, at: x.at ? formatWIB(x.at, 'iso') : null };
  };
  test('"ingetin aku" ke teman → bot menawarkan diri', () => {
    expect(o('eh ingetin aku ya besok jam 7 bawa proyektor')).toEqual({ target: 'self', what: 'bawa proyektor', at: '2026-11-03 07:00' });
  });
  test('"jangan lupa" ke kelas → tawarkan ingatkan kelas', () => {
    // NOW 19.00 → "malam sebelumnya" sudah lewat → pagi harinya, sebelum berangkat.
    expect(o('jangan lupa besok bawa kartu pelajar ya guys')).toEqual({ target: 'group', what: 'bawa kartu pelajar', at: '2026-11-03 06:00', lead: 'morning' });
  });
  test('tanpa jam → diingatkan malam sebelumnya, bukan setelah acaranya lewat', () => {
    expect(o('jangan lupa rabu ulangan matematika')).toEqual({ target: 'group', what: 'ulangan matematika', at: '2026-11-03 19:00', lead: 'eve' });
    expect(o('jangan lupa bayar kas sebelum jumat')).toEqual({ target: 'group', what: 'bayar kas', at: '2026-11-05 19:00', lead: 'eve' });
    // Hari ini tanpa jam: tetap jam default yang masih di depan.
    expect(o('jangan lupa hari ini kumpul tugas')).toEqual({ target: 'group', what: 'kumpul tugas', at: '2026-11-02 20:00' });
  });
  test('yang sudah lewat ("tadi", "kemarin") tidak ditawari', () => {
    expect(o('jangan lupa jam 7 tadi pagi')).toBeNull();
    expect(o('kemarin aku takut lupa jam 8 ada rapat')).toBeNull();
  });
  test('"takut lupa" → pengingat pribadi, isi bisa sebelum pemicunya', () => {
    expect(o('rabu jam 6 pagi aku piket, takut lupa')).toEqual({ target: 'self', what: 'aku piket', at: '2026-11-04 06:00' });
    expect(o('biar gak lupa, jumat sore kumpul tugas PKN')).toEqual({ target: 'self', what: 'kumpul tugas PKN', at: '2026-11-06 16:00' });
  });
  test('tanpa waktu / bukan soal lupa → tidak menawarkan', () => {
    expect(o('jangan lupa bahagia')).toBeNull();
    expect(o('ingetin aku beli spidol')).toBeNull();
    expect(o('besok ulangan matematika')).toBeNull();
    expect(o('aku lupa password')).toBeNull();
  });
});
