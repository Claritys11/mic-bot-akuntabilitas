import { describe, expect, test } from 'bun:test';
import { anonymize, evaluate, parseWhatsAppExport, toHoldout, type HoldoutItem } from '../src/tools/holdout.ts';

const ANDROID = `23/10/26 19.05 - Pesan dan panggilan terenkripsi secara end-to-end.
23/10/26 19.05 - Budi Santoso: aku yang bikin PPT ya, jumat jadi
23/10/26 19.06 - Ani: oke budi makasih
nanti aku bantu bagian kesimpulan
23/10/26 19.07 - Ani: <Media tidak disertakan>
23/10/26 19.08 - Rina: nomorku 0812-3456-7890, email rina@mail.com, tag @6281234567890
23/10/26 19.09 - Budi Santoso menambahkan Rina`;

const IOS = `[23/10/26 19.05.12] Budi: sy yg rangkum bab 3 rabu
[23/10/26 19.06.01] Ani: ‎image omitted`;

describe('parser ekspor chat WhatsApp', () => {
  test('format Android: multi-baris digabung, pesan sistem dilewati, media ditandai', () => {
    const lines = parseWhatsAppExport(ANDROID);
    expect(lines.map((l) => l.author)).toEqual(['Budi Santoso', 'Ani', 'Ani', 'Rina']);
    expect(lines[1]!.text).toBe('oke budi makasih\nnanti aku bantu bagian kesimpulan');
    expect(lines[2]!.media).toBe(true);
    expect(lines[0]!.at).toBe('2026-10-23T12:05:00.000Z'); // 19.05 WIB
  });
  test('format iOS', () => {
    const lines = parseWhatsAppExport(IOS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ author: 'Budi', text: 'sy yg rangkum bab 3 rabu', media: false });
    expect(lines[1]!.media).toBe(true);
  });
});

describe('anonimisasi', () => {
  const anon = anonymize(parseWhatsAppExport(ANDROID));
  test('nama penulis jadi SiswaN, juga nama depan di dalam teks', () => {
    expect(anon.map((l) => l.author)).toEqual(['Siswa1', 'Siswa2', 'Siswa2', 'Siswa3']);
    expect(anon[1]!.text).toContain('oke Siswa1 makasih');
  });
  test('nomor HP, mention nomor, dan email dihapus', () => {
    const t = anon[3]!.text;
    expect(t).not.toMatch(/0812|6281|rina@/i);
    expect(t).toContain('[nomor]');
    expect(t).toContain('@[nomor]');
    expect(t).toContain('[email]');
  });
  test('set holdout tanpa media & belum berlabel', () => {
    const h = toHoldout(anon);
    expect(h).toHaveLength(3);
    expect(h.every((i) => i.label.promise === null)).toBe(true);
  });
});

describe('evaluasi precision/recall', () => {
  const item = (id: number, promise: boolean | null): HoldoutItem => ({ id, at: null, author: 'S', text: '', label: { promise, owner: null, deadline: null } });
  test('memisahkan hilang di prefilter vs ditolak LLM', () => {
    const r = evaluate(
      [item(1, true), item(2, true), item(3, true), item(4, false), item(5, false), item(6, null)],
      [
        { id: 1, passedPrefilter: true, predicted: true, deadlineMatches: true },
        { id: 2, passedPrefilter: false, predicted: false },
        { id: 3, passedPrefilter: true, predicted: false },
        { id: 4, passedPrefilter: true, predicted: true },
        { id: 5, passedPrefilter: false, predicted: false },
        { id: 6, passedPrefilter: true, predicted: true },
      ],
    );
    expect(r).toMatchObject({ labeled: 5, tp: 1, fn: 2, fp: 1, tn: 1, precision: 0.5, recall: 0.333, missedByPrefilter: [2], missedByLlm: [3], falsePositives: [4] });
    expect(r.deadline).toEqual({ checked: 1, correct: 1 });
  });
});
