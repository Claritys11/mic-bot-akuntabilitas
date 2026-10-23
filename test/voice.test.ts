import { describe, expect, test } from 'bun:test';
import { typedAnswer } from '../src/core/promises/service.ts';
import { acceptLlmLine, askLine, cancelledLine, confirmedLine, LABELS } from '../src/core/promises/voice.ts';

const WHO = '{{@u1}}';
const LAUGH = /haha|hehe|wkwk|😆|👀|🔥|🙈/i;

describe('suara bot saat nimbrung janji', () => {
  test('template santai seperti teman sekelas', () => {
    expect(askLine('santai', WHO, 'bikin PPT', 'santai', () => 0)).toBe(`jadi gak ${WHO}? kalau jadi langsung ku catat nih hahaha`);
  });
  test('semua variasi menyebut pemilik', () => {
    for (const level of ['santai', 'sopan', 'krama'] as const) {
      for (const mood of ['santai', 'serius'] as const) {
        for (let i = 0; i < 4; i++) {
          expect(askLine(level, WHO, 'bikin PPT', mood, () => i / 4)).toContain(WHO);
          expect(confirmedLine(level, WHO, i % 2 === 0, mood, () => i / 4)).toContain(WHO);
        }
      }
    }
  });
  test('suasana tidak santai → tidak ada tawa / emoji usil di template mana pun', () => {
    for (const level of ['santai', 'sopan', 'krama'] as const) {
      for (const mood of ['serius', 'tegang', 'sedih'] as const) {
        for (let i = 0; i < 4; i++) {
          expect(askLine(level, WHO, 'bikin PPT', mood, () => i / 4)).not.toMatch(LAUGH);
          expect(confirmedLine(level, WHO, true, mood, () => i / 4)).not.toMatch(LAUGH);
          expect(cancelledLine(level, mood, () => i / 4)).not.toMatch(LAUGH);
        }
      }
    }
  });
  test('label tombol santai', () => {
    expect(LABELS.santai.confirm).toBe('✅ Jadi, catat!');
  });
});

describe('kalimat buatan LLM', () => {
  test('token pemilik diganti mention', () => {
    expect(acceptLlmLine('jadi gak @PEMILIK? kalau jadi ku catat nih hahaha', WHO)).toBe(`jadi gak ${WHO}? kalau jadi ku catat nih hahaha`);
  });
  test('suasana serius → tawa dibuang walau LLM kelepasan', () => {
    expect(acceptLlmLine('jadi gak @PEMILIK? kalau jadi ku catat nih hahaha 😂', WHO, 'serius')).toBe(`jadi gak ${WHO}? kalau jadi ku catat nih`);
  });
  test('ditolak → null (jatuh ke template)', () => {
    expect(acceptLlmLine(null, WHO)).toBeNull();
    expect(acceptLlmLine('jadi gak Budi? ku catat ya', WHO)).toBeNull(); // tanpa token
    expect(acceptLlmLine('@PEMILIK cek https://evil.example', WHO)).toBeNull();
    expect(acceptLlmLine('@PEMILIK @everyone jadi gak?', WHO)).toBeNull();
    expect(acceptLlmLine(`@PEMILIK ${'x'.repeat(300)}`, WHO)).toBeNull();
  });
  test('multi-baris dirapikan jadi satu baris', () => {
    expect(acceptLlmLine('jadi gak\n@PEMILIK?', WHO)).toBe(`jadi gak ${WHO}?`);
  });
});

describe('LLM menulis nama langsung', () => {
  test('"@Ani" diterima kalau nama dikenal, diganti mention', () => {
    expect(acceptLlmLine('oke @Ani, PPT-nya Jumat ya?', WHO, 'santai', ['Ani'])).toBe(`oke ${WHO}, PPT-nya Jumat ya?`);
    expect(acceptLlmLine('oke @ani, PPT-nya Jumat ya?', WHO, 'santai', ['Ani'])).toBe(`oke ${WHO}, PPT-nya Jumat ya?`);
  });
  test('nama tak dikenal tetap ditolak', () => {
    expect(acceptLlmLine('oke @Budi, PPT-nya Jumat ya?', WHO, 'santai', ['Ani'])).toBeNull();
  });
});

describe('jawaban ketik untuk "jadi gak?"', () => {
  test('ya', () => {
    for (const t of ['jadi dong haha', 'jadi', 'iyaa', 'oke siap', 'gas', 'jadi, jumat', 'inggih']) expect(typedAnswer(t)).toBe('yes');
  });
  test('tidak', () => {
    for (const t of ['ga jadi', 'gak jadi deh', 'nggak', 'batal aja', 'bercanda wkwk', 'mboten']) expect(typedAnswer(t)).toBe('no');
  });
  test('bukan jawaban', () => {
    for (const t of ['wkwk', 'besok ujian ya', 'jadinya gimana sih kalau kita ganti topik presentasinya aja biar lebih gampang']) expect(typedAnswer(t)).toBeNull();
  });
});
