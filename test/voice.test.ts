import { describe, expect, test } from 'bun:test';
import { acceptLlmLine, askLine, cancelledLine, confirmedLine, LABELS } from '../src/core/promises/voice.ts';

const WHO = '{{@u1}}';

describe('suara bot saat nimbrung janji', () => {
  test('template santai seperti teman sekelas', () => {
    expect(askLine('santai', WHO, 'bikin PPT', () => 0)).toBe(`jadi gak ${WHO}? kalau jadi langsung ku catat nih hahaha`);
  });
  test('semua variasi menyebut pemilik', () => {
    for (const level of ['santai', 'sopan', 'krama'] as const) {
      for (let i = 0; i < 4; i++) {
        expect(askLine(level, WHO, 'bikin PPT', () => i / 4)).toContain(WHO);
        expect(confirmedLine(level, WHO, i % 2 === 0, () => i / 4)).toContain(WHO);
      }
      expect(cancelledLine(level, () => 0.99).length).toBeGreaterThan(0);
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
