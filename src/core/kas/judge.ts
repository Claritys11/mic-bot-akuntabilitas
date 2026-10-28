import { sanitize, type SpeechLevel } from '../types.ts';

// Gambar di channel kas belum tentu bukti transfer — bisa meme, foto kucing, atau nota belanja.
// Bot menilai dulu: yang jelas bukan bukti dibalas di tempat (tidak merepotkan tim inti), yang ragu
// diminta ulang. Pengirim selalu bisa menekan "Ini beneran bukti" — keputusan akhir tetap di bendahara.

export type ImageVerdict = 'proof' | 'not_proof' | 'receipt' | 'unsure';
export type ImageKind = 'bukti_transfer' | 'nota_belanja' | 'lainnya';

/** Di bawah ini bot menganggap dirinya ragu, apa pun jenis tebakannya. */
export const SURE_MIN = 0.6;

export function judgeImage(x: { jenis?: ImageKind | null; yakin?: number | null; isTransferProof?: boolean | null } | null): ImageVerdict {
  // Tidak bisa menilai (pembaca gambar mati/gagal) → teruskan untuk dicek manual.
  if (!x) return 'proof';
  const kind = x.jenis ?? (x.isTransferProof === false ? 'lainnya' : 'bukti_transfer');
  if ((x.yakin ?? 1) < SURE_MIN) return 'unsure';
  return kind === 'bukti_transfer' ? 'proof' : kind === 'nota_belanja' ? 'receipt' : 'not_proof';
}

// Teks di gambar bisa membujuk model menulis "transfer ke rekening 0812…" — di channel pembayaran itu
// akan terbaca sebagai instruksi resmi bot. Candaan tidak butuh angka, link, atau tujuan pembayaran.
const PAYMENT_HINT =
  /\b(?:rek(?:ening)?|norek|no\.?\s*rek|atas\s+nama|a\.?n\.?|virtual\s+account|va|qris|dana|ovo|gopay|shopeepay|linkaja|bca|bri|bni|mandiri|bsi|pin|otp|password|sandi|kode|link|klik)\b|\b(?:transfer|kirim|bayar|tf)\s+(?:ke|via|lewat)\b/i;

/** Kalimat candaan buatan LLM: dipakai hanya kalau pendek & aman, selain itu null (pakai template). */
export function acceptJokeLine(line: string | null | undefined): string | null {
  if (!line) return null;
  // Normalisasi dulu: angka lebar penuh (０８１２) jadi ASCII, karakter tak terlihat (zero-width) dibuang.
  const t = sanitize(line).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || t.length > 220) return null;
  // Allowlist: hanya huruf Latin, tanda baca dasar, dan emoji — angka (aksara apa pun), huruf mirip dari
  // aksara lain (е Sirilik di "rеkening"), dan simbol lain langsung ditolak.
  if (!JOKE_CHARS.test(t)) return null;
  // Cek kata pembayaran setelah aksen dilucuti ("rekéning" → "rekening").
  const plain = t.normalize('NFD').replace(/\p{M}/gu, '');
  if (/https?|www\.|\b[a-z-]+\.[a-z]{2,}\b/i.test(plain) || PAYMENT_HINT.test(plain)) return null;
  return t;
}
const JOKE_CHARS = /^[\p{Script=Latin}\p{M} .,!?'"()\-–—:;~…\p{Extended_Pictographic}\u{FE0F}\p{Emoji_Modifier}]+$/u;

const FALLBACK: Record<Exclude<ImageVerdict, 'proof'>, Record<SpeechLevel, (desc: string | null) => string>> = {
  not_proof: {
    santai: (d) => `${d ? `wkwk itu sih ${d}` : 'hehe itu kayaknya bukan bukti transfer'} 😆 kalau mau bayar kas, kirim screenshot transfernya ya`,
    sopan: (d) => `${d ? `Sepertinya itu ${d}, bukan bukti transfer` : 'Sepertinya itu bukan bukti transfer'} 🙂 Untuk kas, mohon kirim screenshot bukti transfernya.`,
    krama: (d) => `${d ? `Kadosipun menika ${d}, sanes bukti transfer` : 'Kadosipun menika sanes bukti transfer'} 🙏 Kangge kas, nyuwun screenshot bukti transferipun.`,
  },
  receipt: {
    santai: () => 'ini kayak nota belanja ya 🧾 kalau ini pengeluaran kas, bendahara bisa catat lewat `/kas keluar`',
    sopan: () => 'Ini sepertinya nota belanja 🧾 Bila ini pengeluaran kas, bendahara dapat mencatatnya lewat `/kas keluar`.',
    krama: () => 'Menika kadosipun nota blanja 🧾 Menawi pengeluaran kas, bendahara saged nyathet lumantar `/kas keluar`.',
  },
  unsure: {
    santai: (d) => `hmm aku kurang yakin ini bukti transfer 🤔${d ? ` (keliatannya ${d})` : ''} bisa kirim screenshot yang lebih jelas?`,
    sopan: (d) => `Saya kurang yakin ini bukti transfer${d ? ` (tampaknya ${d})` : ''}. Boleh kirim screenshot yang lebih jelas? 🙏`,
    krama: (d) => `Nuwun sewu, kula kirang yakin menika bukti transfer${d ? ` (katingalipun ${d})` : ''}. Saged dipunkintun screenshot ingkang langkung cetha? 🙏`,
  },
};
const BUTTON_HINT: Record<SpeechLevel, string> = {
  santai: '_kalau ini beneran bukti transfer, klik tombol di bawah biar ku terusin ke bendahara._',
  sopan: '_Bila ini memang beneran bukti transfer, klik tombol di bawah agar saya teruskan ke bendahara._',
  krama: '_Menawi menika beneran bukti transfer, mangga klik tombol ing ngandhap supados kula aturaken dhateng bendahara._',
};
export const SEND_ANYWAY_LABEL: Record<SpeechLevel, string> = { santai: '📨 Ini beneran bukti', sopan: '📨 Ini beneran bukti', krama: '📨 Menika bukti saestu' };

/** Balasan untuk gambar yang ditahan. Candaan LLM hanya untuk "bukan bukti"; selalu diakhiri petunjuk tombol. */
export function heldReplyText(verdict: Exclude<ImageVerdict, 'proof'>, level: SpeechLevel, x: { deskripsi?: string | null; balasan?: string | null }): string {
  const desc = x.deskripsi ? sanitize(x.deskripsi).replace(/[@<>`*_]/g, '').trim().slice(0, 80) || null : null;
  const joke = verdict === 'not_proof' ? acceptJokeLine(x.balasan) : null;
  return `${joke ?? FALLBACK[verdict][level](desc)}\n${BUTTON_HINT[level]}`;
}

/** Kirim meme beruntun tidak dibalas terus — setelah batas, bot diam sampai jendela waktunya lewat. */
export class JokeLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, at = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(key, recent);
    return true;
  }
}
