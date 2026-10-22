import { fromWIB } from '../time.ts';
import { periodKey, periodRange, previousPeriod, type KasPeriod } from './ledger.ts';

// Verifikasi realistis: menandai kejanggalan untuk dicek bendahara. BUKAN deteksi editan/forensik.

export type ProofFlag =
  | 'duplicate_image'
  | 'duplicate_ref'
  | 'amount_mismatch'
  | 'amount_unreadable'
  | 'date_out_of_period'
  | 'date_in_future'
  | 'date_unreadable'
  | 'not_a_proof';

export const FLAG_TEXT: Record<ProofFlag, string> = {
  duplicate_image: 'Gambar ini pernah dikirim sebelumnya',
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
  isTransferProof?: boolean;
}

export interface VerifyContext {
  now: Date;
  amount: number;
  period: KasPeriod;
  seenHashes: Set<string>;
  /** refId yang sudah dipakai, dalam huruf kecil. */
  seenRefIds: Set<string>;
}

export const normalizeRef = (ref: string) => ref.replace(/\s+/g, '').toLowerCase();

export function verifyProof(p: ProofData, ctx: VerifyContext): ProofFlag[] {
  const flags: ProofFlag[] = [];
  if (p.isTransferProof === false) flags.push('not_a_proof');
  if (ctx.seenHashes.has(p.imageHash)) flags.push('duplicate_image');
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
