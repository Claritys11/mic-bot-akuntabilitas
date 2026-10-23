import { describe, expect, test } from 'bun:test';
import { fallbackAnswer, looksLikeQuestion, topicsOf } from '../src/core/chat/ask.ts';
import { detectMood, graverMood, tidyReply } from '../src/core/chat/mood.ts';

describe('membaca suasana', () => {
  test('obrolan biasa / bercanda → santai', () => {
    expect(detectMood(['wkwk iya', 'gas lah'])).toBe('santai');
    expect(detectMood(['aku yang bikin PPT ya, jumat jadi'])).toBe('santai');
    expect(detectMood([])).toBe('santai');
  });
  test('bahas ujian / guru → serius', () => {
    expect(detectMood(['besok ulangan harian bab 3', 'materinya apa aja?'])).toBe('serius');
    expect(detectMood(['tadi dipanggil wali kelas, penting nih'])).toBe('serius');
  });
  test('kabar duka / sakit → sedih, menang atas tawa sebelumnya', () => {
    expect(detectMood(['wkwk', 'gaes, ibunya Rina meninggal tadi pagi'])).toBe('sedih');
    expect(detectMood(['budi masuk rumah sakit'])).toBe('sedih');
  });
  test('kesal / teriak → tegang', () => {
    expect(detectMood(['kok gitu sih, telat lagi tugasnya'])).toBe('tegang');
    expect(detectMood(['INI SIAPA YANG BELUM NGUMPULIN SIH'])).toBe('tegang');
  });
  test('singkatan kapital bukan teriakan', () => {
    expect(detectMood(['aku yang bikin PPT buat RPL'])).toBe('santai');
  });
  test('gabungan dua penilaian ambil yang lebih serius', () => {
    expect(graverMood('santai', 'serius')).toBe('serius');
    expect(graverMood('sedih', 'santai')).toBe('sedih');
    expect(graverMood('santai', null)).toBe('santai');
  });
  test('pagar terakhir membuang tawa saat serius', () => {
    expect(tidyReply('oke, besok ya hahaha 😂', 'serius')).toBe('oke, besok ya');
    expect(tidyReply('oke, besok ya hahaha', 'santai')).toBe('oke, besok ya hahaha');
  });
});

describe('pertanyaan yang dijawab bot', () => {
  test('lolos', () => {
    expect(looksLikeQuestion('ada tugas gak nih?')).toBe(true);
    expect(looksLikeQuestion('ada tugas gak nih')).toBe(true);
    expect(looksLikeQuestion('deadline apa aja minggu ini')).toBe(true);
    expect(looksLikeQuestion('kas aku udah lunas belum')).toBe(true);
    expect(looksLikeQuestion('ada lomba ga?')).toBe(true);
    expect(looksLikeQuestion('PR matematika kapan dikumpulin?')).toBe(true);
    expect(looksLikeQuestion('wonten tugas menapa mboten')).toBe(true);
    expect(looksLikeQuestion('ono tugas ora')).toBe(true);
  });
  test('tidak lolos', () => {
    expect(looksLikeQuestion('wkwk iya bener')).toBe(false);
    expect(looksLikeQuestion('makan dimana ya?')).toBe(false);
    expect(looksLikeQuestion('tugasnya udah aku kirim')).toBe(false);
  });
  test('topik', () => {
    expect(topicsOf('kas sama tugas gimana?')).toEqual(['tugas', 'kas']);
  });
  test('jawaban cadangan dari data, tanpa membeberkan siapa yang belum bayar', () => {
    const facts = {
      janji: [{ tugas: 'bikin PPT', pemilik: 'Ani', deadline: 'Jumat, 23 Okt 20:00 WIB', lewat: false, punyaPenanya: false }],
      kas: { iuran: 'Rp10.000', periode: 'Oktober 2026', penanyaSudahBayar: false, jumlahBelum: 3 },
    };
    const out = fallbackAnswer(facts, ['tugas', 'kas'], 'santai', false)!;
    expect(out).toContain('bikin PPT — Ani');
    expect(out).toContain('kas Oktober 2026 kamu belum');
    expect(fallbackAnswer({ janji: [] }, ['tugas'], 'santai', false)).toContain('belum ada tugas');
    expect(fallbackAnswer({}, [], 'santai', true)).toContain('hadir');
    expect(fallbackAnswer({}, [], 'santai', false)).toBeNull();
  });
});
