import { fromWIB } from '../time.ts';
import { hamming, SIMILAR_MAX_DISTANCE } from './phash.ts';
import { periodKey, periodRange, previousPeriod, type KasPeriod } from './ledger.ts';

// Verifikasi realistis: menandai kejanggalan untuk dicek bendahara. BUKAN deteksi editan/forensik.

export type ProofFlag =
  | 'duplicate_image'
  | 'similar_image'
  | 'recipient_mismatch'
  | 'recipient_unreadable'
  | 'duplicate_ref'
  | 'amount_mismatch'
  | 'amount_unreadable'
  | 'date_out_of_period'
  | 'date_in_future'
  | 'date_unreadable'
  | 'not_a_proof';

export const FLAG_TEXT: Record<ProofFlag, string> = {
  duplicate_image: 'Gambar ini pernah dikirim sebelumnya',
  similar_image: 'Gambar sangat mirip bukti yang pernah dikirim (mungkin di-screenshot ulang)',
  recipient_mismatch: 'Penerima transfer bukan rekening kas yang terdaftar',
  recipient_unreadable: 'Nama penerima tidak terbaca',
  duplicate_ref: 'Nomor referensi transaksi sudah pernah dipakai',
  amount_mismatch: 'Nominal bukan kelipatan iuran',
  amount_unreadable: 'Nominal tidak terbaca',
  date_out_of_period: 'Tanggal transfer di luar periode iuran',
  date_in_future: 'Tanggal transfer di masa depan',
  date_unreadable: 'Tanggal tidak terbaca',
  not_a_proof: 'Gambar sepertinya bukan bukti transfer',
};

export interface ProofData {
  nominal: number | null;
  tanggal: string | null; // YYYY-MM-DD
  refId: string | null;
  imageHash: string;
  /** dHash; null kalau format gambar tidak didukung. */
  imagePHash?: string | null;
  /** Nama penerima seperti tertulis di bukti (boleh tersamar, mis. "ELANG D***"). */
  penerima?: string | null;
  isTransferProof?: boolean;
}

export interface VerifyContext {
  now: Date;
  amount: number;
  period: KasPeriod;
  seenHashes: Set<string>;
  seenPHashes?: string[];
  /** Nama rekening/e-wallet tujuan kas yang sah. Kosong = belum diatur, penerima tidak dicek. */
  recipients?: string[];
  /** refId yang sudah dipakai, dalam huruf kecil. */
  seenRefIds: Set<string>;
}

export const normalizeRef = (ref: string) => ref.replace(/\s+/g, '').toLowerCase();

export function verifyProof(p: ProofData, ctx: VerifyContext): ProofFlag[] {
  const flags: ProofFlag[] = [];
  if (p.isTransferProof === false) flags.push('not_a_proof');
  if (ctx.seenHashes.has(p.imageHash)) flags.push('duplicate_image');
  else if (p.imagePHash && ctx.seenPHashes?.some((h) => hamming(h, p.imagePHash!) <= SIMILAR_MAX_DISTANCE)) flags.push('similar_image');
  if (ctx.recipients?.length) {
    if (!p.penerima?.trim()) flags.push('recipient_unreadable');
    else if (!ctx.recipients.some((r) => recipientMatches(p.penerima!, r))) flags.push('recipient_mismatch');
  }
  if (p.refId && ctx.seenRefIds.has(normalizeRef(p.refId))) flags.push('duplicate_ref');

  if (p.nominal == null || p.nominal <= 0) flags.push('amount_unreadable');
  else if (ctx.amount > 0 && p.nominal % ctx.amount !== 0) flags.push('amount_mismatch');

  const m = p.tanggal?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    flags.push('date_unreadable');
  } else {
    const date = fromWIB(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const current = periodKey(ctx.now, ctx.period);
    // Telat bayar periode sebelumnya masih wajar; lebih lama dari itu ditandai.
    const earliest = periodRange(previousPeriod(current, ctx.period)).start;
    if (date.getTime() > ctx.now.getTime()) flags.push('date_in_future');
    else if (date < earliest) flags.push('date_out_of_period');
  }
  return flags;
}

const nameTokens = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9*]+/g, ' ')
    .split(' ')
    .filter(Boolean);

/**
 * Apakah nama penerima di bukti cocok dengan nama rekening kas. Bank sering menyamarkan nama
 * ("ELANG D***", "E**** DIMAS") → token bertanda * cocok bila awalannya sama. Butuh ≥ 2 token cocok
 * (1 kalau nama rekening kas satu kata) dan minimal satu token utuh ≥ 3 huruf, supaya
 * "D***" saja atau kata umum tidak cukup.
 */
export function recipientMatches(extracted: string, expected: string): boolean {
  const xs = nameTokens(extracted);
  const es = nameTokens(expected);
  if (!xs.length || !es.length) return false;
  // Tiap token nama rekening hanya boleh "terpakai" sekali — "SARI SARI" tidak boleh menutupi "Sari Dewi".
  const used = new Set<number>();
  let solid = false;
  for (const x of xs) {
    const masked = x.includes('*');
    const p = x.replace(/\*+/g, '');
    if (!p) continue;
    // Tersamar: awalan sama. Utuh: sama persis, atau terpotong di bukti (≥ 3 huruf, mis. "LESTA" ← "LESTARI").
    const i = es.findIndex((e, idx) => !used.has(idx) && (masked ? e.startsWith(p) : e === p || (p.length >= 3 && e.startsWith(p))));
    if (i < 0) continue;
    used.add(i);
    if (!masked && p.length >= 3) solid = true;
  }
  return solid && used.size >= Math.min(2, es.length);
}
