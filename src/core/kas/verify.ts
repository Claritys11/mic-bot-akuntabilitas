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
  | 'not_a_proof'
  | 'sent_anyway'
  | 'reader_failed';

export const FLAG_TEXT: Record<ProofFlag, string> = {
  duplicate_image: 'Gambar ini pernah dikirim sebelumnya',
  similar_image: 'Gambar sangat mirip bukti yang pernah dikirim — cek nomor ref-nya',
  recipient_mismatch: 'Penerima transfer bukan rekening kas yang terdaftar',
  recipient_unreadable: 'Nama penerima tidak terbaca',
  duplicate_ref: 'Nomor referensi transaksi sudah pernah dipakai',
  amount_mismatch: 'Nominal bukan kelipatan iuran',
  amount_unreadable: 'Nominal tidak terbaca',
  date_out_of_period: 'Tanggal transfer di luar periode iuran',
  date_in_future: 'Tanggal transfer di masa depan',
  date_unreadable: 'Tanggal tidak terbaca',
  not_a_proof: 'Gambar sepertinya bukan bukti transfer',
  reader_failed: 'Pembaca gambar bot sedang gagal — nominal/tanggal/penerima belum dicek, mohon cek manual',
  sent_anyway: 'Bot menilai ini bukan / belum tentu bukti transfer, tapi pengirim bilang ini bukti — cek teliti',
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

export interface SeenImage {
  pHash: string;
  /** Kunci refId (lihat refKey) atau null kalau tidak terbaca. */
  refKey: string | null;
  nominal: number | null;
  tanggal: string | null;
  /** Bisa null: detail penerima dihapus setelah bukti ditinjau (privasi). */
  penerima: string | null;
}

/** Jarak dHash ≤ ini + ref BERBEDA + nominal/tanggal/penerima sama → curiga ref diedit di screenshot lama. */
export const EDITED_REF_MAX_DISTANCE = 3;

export interface VerifyContext {
  now: Date;
  amount: number;
  period: KasPeriod;
  seenHashes: Set<string>;
  seenPHashes?: string[];
  /** Bukti sebelumnya + data pembeda, untuk membedakan "struk mirip" dari "struk yang sama". */
  seenImages?: SeenImage[];
  /** Nama rekening/e-wallet tujuan kas yang sah. Kosong = belum diatur, penerima tidak dicek. */
  recipients?: string[];
  /** Kunci refId yang sudah dipakai (lihat refKey). */
  seenRefIds: Set<string>;
  /** Ubah refId jadi kunci pembanding; default normalizeRef. Service memakai hash agar refId mentah tidak disimpan. */
  refKey?: (ref: string) => string;
}

export const UNREADABLE: ProofFlag[] = ['amount_unreadable', 'date_unreadable', 'recipient_unreadable'];
/** Vision gagal → "tidak terbaca" bukan salah gambarnya; ganti dengan satu catatan yang jujur. */
export function markReaderFailed(flags: ProofFlag[]): ProofFlag[] {
  return [...flags.filter((f) => !UNREADABLE.includes(f)), 'reader_failed'];
}

export const normalizeRef = (ref: string) => ref.replace(/\s+/g, '').toLowerCase();

export function verifyProof(p: ProofData, ctx: VerifyContext): ProofFlag[] {
  const flags: ProofFlag[] = [];
  if (p.isTransferProof === false) flags.push('not_a_proof');
  if (ctx.seenHashes.has(p.imageHash)) flags.push('duplicate_image');
  else if (p.imagePHash && isSimilarToSeen(p, ctx)) flags.push('similar_image');
  if (ctx.recipients?.length) {
    if (!p.penerima?.trim()) flags.push('recipient_unreadable');
    else if (!ctx.recipients.some((r) => recipientMatches(p.penerima!, r))) flags.push('recipient_mismatch');
  }
  if (p.refId && ctx.seenRefIds.has((ctx.refKey ?? normalizeRef)(p.refId))) flags.push('duplicate_ref');

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

const normName = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Struk dari aplikasi bank yang sama tata letaknya identik → dHash mirip walau transaksinya berbeda
 * (temuan QA T14). Jadi: kalau nomor ref terbaca di keduanya dan BERBEDA → transaksi lain, kecuali
 * gambarnya nyaris identik DAN nominal, tanggal, penerima sama (tanda ref diedit di screenshot lama).
 */
function isSimilarToSeen(p: ProofData, ctx: VerifyContext): boolean {
  const key = p.refId ? (ctx.refKey ?? normalizeRef)(p.refId) : null;
  const legacy = (ctx.seenPHashes ?? []).map((h) => ({ pHash: h, refKey: null, nominal: null, tanggal: null, penerima: null }));
  return [...(ctx.seenImages ?? []), ...legacy].some((seen) => {
    const d = hamming(seen.pHash, p.imagePHash!);
    if (d > SIMILAR_MAX_DISTANCE) return false;
    if (!key || !seen.refKey || key === seen.refKey) return true;
    const samePenerima = !seen.penerima || !p.penerima || normName(seen.penerima) === normName(p.penerima);
    return d <= EDITED_REF_MAX_DISTANCE && seen.nominal === p.nominal && seen.tanggal === p.tanggal && samePenerima;
  });
}
