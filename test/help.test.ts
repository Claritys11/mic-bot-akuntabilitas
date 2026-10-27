import { describe, expect, test } from 'bun:test';
import { HELP_WORDS, helpText } from '../src/core/help.ts';

describe('panduan /bantuan', () => {
  test('anggota: fitur utama lewat obrolan, tanpa bagian pengurus', () => {
    const t = helpText({ isAdmin: false, kasChannelId: 'k1' });
    for (const w of ['Janji', 'ingetin', 'Bayar kas', 'Info lomba', '/janji list', '/data hapus-saya']) expect(t).toContain(w);
    expect(t).not.toContain('Khusus pengurus');
  });
  test('pengurus melihat perintah pengaturan', () => {
    const t = helpText({ isAdmin: true });
    expect(t).toContain('Khusus pengurus');
    expect(t).toContain('cek_bukti');
  });
  test.each(['@MIC bisa apa aja?', '@MIC help', 'cara pakai botnya gimana', '@MIC bantuan dong'])('%p dikenali', (s) => {
    expect(HELP_WORDS.test(s)).toBe(true);
  });
});
