import { describe, expect, test } from 'bun:test';
import { heuristicExtract, looksLikePromise } from '../src/core/promises/prefilter.ts';

describe('prefilter janji', () => {
  test('lolos untuk kalimat janji', () => {
    expect(looksLikePromise('aku yang bikin PPT ya, Jumat jadi')).toBe(true);
    expect(looksLikePromise('Saya yang urus konsumsi besok')).toBe(true);
    expect(looksLikePromise('biar aku aja yang print, deadline tgl 30')).toBe(true);
    expect(looksLikePromise('gue yang transfer ke vendor')).toBe(true);
  });

  test('tidak lolos untuk obrolan biasa', () => {
    expect(looksLikePromise('wkwk iya bener')).toBe(false);
    expect(looksLikePromise('mantap')).toBe(false);
    expect(looksLikePromise('makan apa ya')).toBe(false);
    expect(looksLikePromise('')).toBe(false);
  });
});

// Set berlabel: termasuk kalimat yang dulu lolos dari filter (temuan review). Prefilter mengutamakan
// recall — salah tangkap masih disaring LLM, tapi janji yang tidak lolos di sini hilang selamanya.
const PROMISES = [
  'aku yang bikin PPT ya, Jumat jadi',
  'Saya yang urus konsumsi besok',
  'biar aku aja yang print, deadline tgl 30',
  'gue yang transfer ke vendor',
  'ntar ku kerjain slide nya',
  'sy yg rangkum bab 3 rabu',
  'oke tak garapne mengko bengi',
  'aku handle backend, minggu depan beres',
  'nanti tak kirim jam 8',
  'aku aja yang presentasi',
  'yaudah aku yang kerjain bab 2 malam ini',
  'siap, aku bawa proyektor besok',
  'gw yg beli spidol',
  'aku ambil bagian kesimpulan ya',
  'tak beliin kertas sesuk',
  'kula ingkang damel laporan',
  'aku kerjain malam ini',
  'biar saya yang hubungi pak guru',
  'ok aku siapin materi buat senin',
  '@Budi yang bikin poster ya, senin',
  'aq yg ngeprint besok pagi',
  'aku urus absen hari kamis',
  'ane yang bawa laptop besok',
  'besok aku kumpulin tugasnya',
  'kukerjain sekarang deh, maks jam 9 kelar',
  'aku sing nggawe ppt sesuk',
];
const NOT_PROMISES = [
  'kemarin aku yang bikin ppt',
  'tadi aku udah kirim ke grup',
  'minggu lalu aku yang presentasi',
  'wingi aku sing nggawe',
  'wkwk iya bener',
  'mantap',
  'makan apa ya',
  'siapa yang bikin ppt?',
  'besok libur ya?',
  'tak tahu deh',
  'aku tak bisa datang besok',
  'aku capek banget',
  'ppt nya udah jadi belum',
];

describe('prefilter: set berlabel', () => {
  test.each(PROMISES)('janji lolos: %p', (t) => expect(looksLikePromise(t)).toBe(true));
  test.each(NOT_PROMISES)('bukan janji ditolak: %p', (t) => expect(looksLikePromise(t)).toBe(false));
});

describe('heuristicExtract (cadangan tanpa LLM)', () => {
  test('ambil tugas dari pola "aku yang ..."', () => {
    const r = heuristicExtract('aku yang bikin PPT ya, Jumat jadi');
    expect(r?.isPromise).toBe(true);
    expect(r?.task.toLowerCase()).toContain('bikin ppt');
    expect(r?.deadlineText?.toLowerCase()).toContain('jumat');
  });

  test('bukan janji → null', () => {
    expect(heuristicExtract('besok libur ya?')).toBeNull();
  });
});
