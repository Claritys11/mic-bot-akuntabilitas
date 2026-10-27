import { DAY_MS, fromWIB, wibParts } from '../time.ts';

// Ledger kas: append-only. Koreksi = entri baru (negatif) yang menunjuk entri asal.

export type KasPeriod = 'mingguan' | 'bulanan';
export type EntryKind = 'iuran' | 'koreksi' | 'pengeluaran' | 'pemasukan';

export interface LedgerEntry {
  id: string;
  memberId: string | null;
  memberName: string;
  amount: number;
  kind: EntryKind;
  period: string;
  createdAt: Date;
  note?: string;
  reversalOf?: string;
  createdBy?: string;
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** ISO week (Senin) dari tanggal kalender WIB. */
function isoWeek(year: number, month: number, day: number): { year: number; week: number } {
  const date = new Date(Date.UTC(year, month, day));
  const dow = (date.getUTCDay() + 6) % 7; // Senin = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // Kamis di minggu yang sama
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const fdow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdow + 3);
  return { year: isoYear, week: 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS)) };
}

export function periodKey(at: Date, period: KasPeriod): string {
  const p = wibParts(at);
  if (period === 'bulanan') return `${p.year}-${String(p.month + 1).padStart(2, '0')}`;
  const w = isoWeek(p.year, p.month, p.day);
  return `${w.year}-W${String(w.week).padStart(2, '0')}`;
}

export function periodRange(key: string): { start: Date; end: Date } {
  const week = key.match(/^(\d{4})-W(\d{2})$/);
  if (week) {
    const year = Number(week[1]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const mondayW1 = 4 - ((jan4.getUTCDay() + 6) % 7);
    const startDay = mondayW1 + (Number(week[2]) - 1) * 7;
    return { start: fromWIB(year, 0, startDay), end: fromWIB(year, 0, startDay + 7) };
  }
  const [y, m] = key.split('-').map(Number) as [number, number];
  return { start: fromWIB(y, m - 1, 1), end: fromWIB(y, m, 1) };
}

export function previousPeriod(key: string, period: KasPeriod): string {
  return periodKey(new Date(periodRange(key).start.getTime() - 1), period);
}

export function periodLabel(key: string): string {
  const week = key.match(/^(\d{4})-W(\d{2})$/);
  if (week) return `minggu ke-${Number(week[2])} ${week[1]}`;
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${BULAN[m - 1]} ${y}`;
}

export function balance(entries: LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

export function reversalOf(entry: LedgerEntry, note: string, createdBy: string, at: Date): LedgerEntry {
  return {
    id: `rev-${entry.id}`,
    memberId: entry.memberId,
    memberName: entry.memberName,
    amount: -entry.amount,
    kind: 'koreksi',
    period: entry.period,
    createdAt: at,
    note,
    reversalOf: entry.id,
    createdBy,
  };
}

export interface MemberStatus {
  id: string;
  name: string;
  paidAmount: number;
}

/** Siapa sudah/belum lunas iuran di sebuah periode (iuran + koreksinya). */
export interface Rate {
  amount: number;
  period: KasPeriod;
  /** Kunci periode mulai berlaku ('0000' = sejak awal). */
  from: string;
}

/** Iuran yang berlaku di sebuah periode: tarif terakhir yang sudah berlaku (jenis periode sama), atau tarif sekarang. */
export function rateFor(rates: readonly Rate[] | null | undefined, current: { amount: number; period: KasPeriod }, period: string): number {
  const weekly = /-W\d{2}$/.test(period);
  const match = (rates ?? []).filter((r) => (r.period === 'mingguan') === weekly && (r.from === '0000' || r.from <= period));
  return match.length ? match[match.length - 1]!.amount : current.amount;
}

/** Hitung periode berikutnya. */
export function nextPeriod(key: string, period: KasPeriod): string {
  return periodKey(periodRange(key).end, period);
}

/**
 * Alokasi pembayaran ke periode tertua yang belum lunas dulu (FIFO): rapel, bayar sebagian, dan bayar di muka.
 * Maks 12 periode setelah periode sekarang; sisanya ditumpuk di periode terakhir supaya uang tidak hilang.
 */
export function allocatePayment(i: {
  nominal: number;
  memberId: string;
  entries: LedgerEntry[];
  kasPeriod: KasPeriod;
  rate: (period: string) => number;
  /** Periode pertama yang ditagih (mis. saat kas diatur). */
  start: string;
  current: string;
  maxAhead?: number;
}): { period: string; amount: number }[] {
  const paid = new Map<string, number>();
  for (const e of i.entries) {
    if (e.memberId !== i.memberId || (e.kind !== 'iuran' && e.kind !== 'koreksi')) continue;
    paid.set(e.period, (paid.get(e.period) ?? 0) + e.amount);
  }
  let last = i.current;
  for (let n = 0; n < (i.maxAhead ?? 12); n++) last = nextPeriod(last, i.kasPeriod);
  const out: { period: string; amount: number }[] = [];
  let remaining = i.nominal;
  let p = i.start <= i.current ? i.start : i.current;
  for (let guard = 0; remaining > 0 && guard < 200; guard++) {
    const due = Math.max(0, i.rate(p) - (paid.get(p) ?? 0));
    const take = p === last ? remaining : Math.min(remaining, due);
    if (take > 0) {
      out.push({ period: p, amount: take });
      remaining -= take;
    }
    if (p === last) break;
    p = nextPeriod(p, i.kasPeriod);
  }
  return out;
}

export function paidStatus(
  members: { id: string; name: string }[],
  entries: LedgerEntry[],
  amount: number | ((period: string) => number),
  period: string,
): { paid: MemberStatus[]; unpaid: MemberStatus[] } {
  const due = typeof amount === 'function' ? amount(period) : amount;
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (!e.memberId || e.period !== period) continue;
    if (e.kind !== 'iuran' && e.kind !== 'koreksi') continue;
    totals.set(e.memberId, (totals.get(e.memberId) ?? 0) + e.amount);
  }
  const paid: MemberStatus[] = [];
  const unpaid: MemberStatus[] = [];
  for (const m of members) {
    const s = { id: m.id, name: m.name, paidAmount: totals.get(m.id) ?? 0 };
    (s.paidAmount >= due ? paid : unpaid).push(s);
  }
  return { paid, unpaid };
}

export const csvCell = (v: string | number) => {
  let s = String(v);
  // Cegah formula injection saat dibuka di Excel/Sheets (nama anggota bisa diawali "=").
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(entries: LedgerEntry[]): string {
  const rows: (string | number)[][] = [['tanggal', 'anggota', 'jenis', 'periode', 'nominal', 'catatan', 'id']];
  for (const e of entries) {
    rows.push([e.createdAt.toISOString(), e.memberName, e.kind, e.period, e.amount, e.note ?? '', e.id]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

export const rupiah = (n: number) => `Rp${n.toLocaleString('id-ID')}`;
