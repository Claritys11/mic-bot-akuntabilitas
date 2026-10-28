import { describe, expect, test } from 'bun:test';
import { acceptJokeLine, heldReplyText, judgeImage, JokeLimiter } from '../src/core/kas/judge.ts';
import { markReaderFailed } from '../src/core/kas/verify.ts';

describe('menilai gambar di channel kas', () => {
  test('bukti transfer yang yakin → diteruskan', () => {
    expect(judgeImage({ jenis: 'bukti_transfer', yakin: 0.9 })).toBe('proof');
  });
  test('model lama tanpa "jenis": ikuti isTransferProof', () => {
    expect(judgeImage({ isTransferProof: true })).toBe('proof');
    expect(judgeImage({ isTransferProof: false })).toBe('not_proof');
  });
  test('meme / foto lain yang jelas → bukan bukti', () => {
    expect(judgeImage({ jenis: 'lainnya', yakin: 0.95 })).toBe('not_proof');
  });
  test('nota belanja → diarahkan ke /kas keluar', () => {
    expect(judgeImage({ jenis: 'nota_belanja', yakin: 0.8 })).toBe('receipt');
  });
  test('ragu-ragu (apa pun jenisnya) → minta yang lebih jelas', () => {
    expect(judgeImage({ jenis: 'bukti_transfer', yakin: 0.4 })).toBe('unsure');
    expect(judgeImage({ jenis: 'lainnya', yakin: 0.3 })).toBe('unsure');
  });
  test('pembaca gambar mati / gagal → tetap diteruskan (jangan telan pembayaran)', () => {
    expect(judgeImage(null)).toBe('proof');
  });
});

describe('balasan untuk gambar yang ditahan', () => {
  test('kalimat candaan LLM dipakai kalau aman', () => {
    expect(acceptJokeLine('wkwk itu mah kucing lagi rebahan, bukan bukti transfer 😹')).toBe('wkwk itu mah kucing lagi rebahan, bukan bukti transfer 😹');
  });
  test('kalimat LLM ditolak kalau ada link / mention / kepanjangan / kosong', () => {
    expect(acceptJokeLine('cek https://bank.example')).toBeNull();
    expect(acceptJokeLine('@everyone lihat nih')).toBeNull();
    expect(acceptJokeLine('<@123> haha')).toBeNull();
    expect(acceptJokeLine('x'.repeat(300))).toBeNull();
    expect(acceptJokeLine('  ')).toBeNull();
    expect(acceptJokeLine(null)).toBeNull();
  });
  test('cadangan tanpa LLM menyebut isi gambar & cara yang benar', () => {
    const t = heldReplyText('not_proof', 'santai', { deskripsi: 'foto kucing oranye' });
    expect(t).toContain('foto kucing oranye');
    expect(t).toMatch(/screenshot/i);
  });
  test('nota belanja → sebut /kas keluar; ragu → minta lebih jelas', () => {
    expect(heldReplyText('receipt', 'sopan', {})).toContain('/kas keluar');
    expect(heldReplyText('unsure', 'santai', {})).toMatch(/jelas/);
  });
  test('selalu ada petunjuk tombol kalau ternyata memang bukti', () => {
    for (const v of ['not_proof', 'receipt', 'unsure'] as const) expect(heldReplyText(v, 'santai', {})).toMatch(/beneran bukti/i);
  });
});

describe('batas candaan per orang', () => {
  test('maks 3 balasan per 10 menit per orang, lalu diam', () => {
    const lim = new JokeLimiter(3, 10 * 60_000);
    const t0 = 1_000_000;
    expect([1, 2, 3, 4].map((i) => lim.allow('g:ani', t0 + i))).toEqual([true, true, true, false]);
    expect(lim.allow('g:budi', t0 + 5)).toBe(true);
    expect(lim.allow('g:ani', t0 + 10 * 60_000 + 10)).toBe(true);
  });
});

describe('pembaca gambar gagal', () => {
  test('"tidak terbaca" diganti satu catatan bahwa bot yang gagal; tanda lain tetap', () => {
    expect(markReaderFailed(['duplicate_image', 'amount_unreadable', 'date_unreadable', 'recipient_unreadable'])).toEqual(['duplicate_image', 'reader_failed']);
  });
});
