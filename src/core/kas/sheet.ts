import { formatWIB } from '../time.ts';
import { balance, paidStatus, periodKey, periodLabel, previousPeriod, rupiah, type KasPeriod, type LedgerEntry } from './ledger.ts';

// Isi Google Sheet kas kelas (murni — penulisan ke Google ada di src/integrations/google).
// Bot menimpa tab-tab ini setiap ada perubahan; catatan manual bendahara taruh di tab lain.

export type Cell = string | number;
export interface SheetTab {
  title: string;
  rows: Cell[][];
}

export const MARKER_LABEL = 'ID kelas (jangan diubah)';

/** Penanda tetap per kelas (bukan rahasia — hanya untuk mengenali pemilik sheet). */
export function sheetMarker(platform: string, groupId: string): string {
  let h = 2166136261;
  for (const ch of `${platform}:${groupId}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `MIC-${h.toString(36).toUpperCase()}`;
}

export const KAS_TABS = ['Ringkasan', 'Buku Kas', 'Status Iuran', 'Bukti Transfer'] as const;
const HISTORY_PERIODS = 6;

export interface KasSheetInput {
  className: string;
  /** Penanda kelas pemilik sheet (lihat sheetMarker) — mencegah sheet kelas lain tertimpa. */
  marker: string;
  amount: number;
  period: KasPeriod;
  now: Date;
  members: { id: string; name: string }[];
  entries: LedgerEntry[];
  proofs: { createdAt: Date; memberName: string; nominal: number | null; period: string; status: string; flags: string[] }[];
  flagText: (flag: string) => string;
}

const KIND_LABEL: Record<LedgerEntry['kind'], string> = { iuran: 'Iuran', koreksi: 'Koreksi', pengeluaran: 'Pengeluaran', pemasukan: 'Pemasukan lain' };
const STATUS_LABEL: Record<string, string> = { pending: 'Menunggu cek', approved: 'Disetujui', rejected: 'Ditolak' };

export function buildKasSheet(i: KasSheetInput): SheetTab[] {
  const current = periodKey(i.now, i.period);
  const periods = [current];
  while (periods.length < HISTORY_PERIODS) periods.unshift(previousPeriod(periods[0]!, i.period));
  const statusNow = paidStatus(i.members, i.entries, i.amount, current);
  const income = i.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const spent = -i.entries.filter((e) => e.amount < 0 && e.kind === 'pengeluaran').reduce((s, e) => s + e.amount, 0);

  const ringkasan: Cell[][] = [
    ['Kas kelas', i.className],
    ['Iuran', `${rupiah(i.amount)} / ${i.period === 'bulanan' ? 'bulan' : 'minggu'}`],
    ['Saldo', balance(i.entries)],
    ['Total masuk', income],
    ['Total pengeluaran', spent],
    ['Periode berjalan', periodLabel(current)],
    ['Sudah lunas periode ini', statusNow.paid.length],
    ['Belum lunas periode ini', statusNow.unpaid.length],
    ['Diperbarui', formatWIB(i.now)],
    [MARKER_LABEL, i.marker],
    [],
    ['Sheet ini diisi otomatis oleh MIC-Bot dari catatan kas kelas. Jangan ubah tab buatan bot — tulis catatan sendiri di tab baru.'],
    ['Pengeluaran / pemasukan lain dicatat lewat /kas keluar dan /kas masuk di Discord.'],
  ];

  let running = 0;
  const bukuKas: Cell[][] = [['Tanggal', 'Anggota / keterangan', 'Jenis', 'Periode', 'Masuk', 'Keluar', 'Saldo', 'Catatan']];
  for (const e of [...i.entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    running += e.amount;
    bukuKas.push([
      formatWIB(e.createdAt, 'iso'),
      e.memberName,
      KIND_LABEL[e.kind],
      e.kind === 'iuran' || e.kind === 'koreksi' ? periodLabel(e.period) : '',
      e.amount > 0 ? e.amount : '',
      e.amount < 0 ? -e.amount : '',
      running,
      e.note ?? '',
    ]);
  }

  const status: Cell[][] = [['Anggota', ...periods.map(periodLabel), `Status ${periodLabel(current)}`]];
  const perPeriod = periods.map((p) => {
    const st = paidStatus(i.members, i.entries, i.amount, p);
    return new Map([...st.paid, ...st.unpaid].map((s) => [s.id, s.paidAmount]));
  });
  for (const m of [...i.members].sort((a, b) => a.name.localeCompare(b.name))) {
    const now = statusNow.paid.find((s) => s.id === m.id) ? 'Lunas' : `Kurang ${rupiah(i.amount - (perPeriod.at(-1)!.get(m.id) ?? 0))}`;
    status.push([m.name, ...perPeriod.map((map) => map.get(m.id) || ''), now]);
  }

  const bukti: Cell[][] = [['Dikirim', 'Anggota', 'Nominal', 'Periode', 'Status', 'Catatan otomatis']];
  for (const p of [...i.proofs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    bukti.push([formatWIB(p.createdAt, 'iso'), p.memberName, p.nominal ?? '', periodLabel(p.period), STATUS_LABEL[p.status] ?? p.status, p.flags.map(i.flagText).join('; ')]);
  }

  return [
    { title: 'Ringkasan', rows: ringkasan },
    { title: 'Buku Kas', rows: bukuKas },
    { title: 'Status Iuran', rows: status },
    { title: 'Bukti Transfer', rows: bukti },
  ];
}

/** Akses ke Google Sheets yang disediakan adapter (core tidak memanggil jaringan langsung). */
export interface KasSheetGateway {
  serviceEmail: string;
  /** Akses + judul + penanda kelas yang sudah tertulis di tab Ringkasan (null kalau belum pernah diisi bot). */
  check(spreadsheetId: string): Promise<{ ok: true; title: string; marker: string | null } | { ok: false; reason: string }>;
}

/** Ambil ID spreadsheet dari link Google Sheets (atau ID polos). */
export function spreadsheetIdOf(input: string): string | null {
  const m = input.trim().match(/(?:\/spreadsheets\/d\/|^)([a-zA-Z0-9_-]{30,80})(?:[/?#]|$)/);
  return m ? m[1]! : null;
}
