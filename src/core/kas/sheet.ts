import { formatWIB } from '../time.ts';
import { balance, paidStatus, periodKey, periodLabel, previousPeriod, rupiah, type KasPeriod, type LedgerEntry } from './ledger.ts';

// Isi Google Sheet kas kelas (murni — penulisan ke Google ada di src/integrations/google).
// Bot menimpa tab-tab ini setiap ada perubahan; catatan manual bendahara taruh di tab lain.

export type Cell = string | number;
export interface SheetTab {
  title: string;
  rows: Cell[][];
  /** Baris 1 = judul kolom tabel → header berwarna, baris belang, filter, baris 1 dibekukan. */
  table: boolean;
  /** Kolom (0-based) berisi rupiah → tampil "Rp10.000" tapi tetap angka (bisa dijumlah/diurutkan). */
  moneyCols?: number[];
  /** Kolom status → diwarnai menurut awal teksnya (hijau/kuning/merah). */
  status?: { col: number; good: string[]; wait?: string[]; bad: string[] };
  /** Lebar kolom tetap (piksel); tanpa ini kolom dipaskan dengan isinya. */
  widths?: number[];
}

export const MARKER_LABEL = 'ID kelas (jangan diubah)';

/** Penanda tetap per kelas (bukan rahasia — hanya untuk mengenali pemilik sheet). */
export function sheetMarker(platform: string, groupId: string): string {
  let h = 2166136261;
  for (const ch of `${platform}:${groupId}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `MIC-${h.toString(36).toUpperCase()}`;
}

export const KAS_TABS = ['Ringkasan', 'Buku Kas', 'Status Iuran', 'Bukti Transfer', 'Jejak Audit'] as const;
const HISTORY_PERIODS = 6;

export interface KasSheetInput {
  className: string;
  /** Iuran per periode (riwayat tarif); default `amount`. */
  rate?: (period: string) => number;
  /** Penanda kelas pemilik sheet (lihat sheetMarker) — mencegah sheet kelas lain tertimpa. */
  marker: string;
  amount: number;
  period: KasPeriod;
  now: Date;
  members: { id: string; name: string }[];
  entries: LedgerEntry[];
  proofs: { createdAt: Date; memberName: string; nominal: number | null; period: string; status: string; flags: string[] }[];
  flagText: (flag: string) => string;
  /** Tindakan kas & tim inti (siapa menyetujui/menolak/mencatat apa) — terbaru dulu. */
  audits?: { at: Date; actorName: string; action: string; detail: string }[];
}

const ACTION_LABEL: Record<string, string> = {
  'kas.setujui': 'Setujui bukti',
  'kas.tolak': 'Tolak bukti',
  'kas.keluar': 'Catat pengeluaran',
  'kas.tunai': 'Catat bayar tunai',
  'kas.masuk': 'Catat pemasukan',
  'kas.atur': 'Atur iuran',
  'kas.sheet': 'Sambungkan Sheet',
  'tim.tambah': 'Tambah tim inti',
  'tim.hapus': 'Copot tim inti',
};

const KIND_LABEL: Record<LedgerEntry['kind'], string> = { iuran: 'Iuran', koreksi: 'Koreksi', pengeluaran: 'Pengeluaran', pemasukan: 'Pemasukan lain' };
const STATUS_LABEL: Record<string, string> = { pending: 'Menunggu cek', approved: 'Disetujui', rejected: 'Ditolak' };

export function buildKasSheet(i: KasSheetInput): SheetTab[] {
  const current = periodKey(i.now, i.period);
  const periods = [current];
  while (periods.length < HISTORY_PERIODS) periods.unshift(previousPeriod(periods[0]!, i.period));
  const rate = i.rate ?? (() => i.amount);
  const statusNow = paidStatus(i.members, i.entries, rate, current);
  const income = i.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const spent = -i.entries.filter((e) => e.amount < 0 && e.kind === 'pengeluaran').reduce((s, e) => s + e.amount, 0);

  const ringkasan: Cell[][] = [
    [`Laporan Kas ${i.className}`],
    [`Diperbarui otomatis ${formatWIB(i.now)}`],
    [],
    ['Saldo', balance(i.entries)],
    ['Total masuk', income],
    ['Total pengeluaran', spent],
    [],
    ['Iuran', `${rupiah(i.amount)} / ${i.period === 'bulanan' ? 'bulan' : 'minggu'}`],
    ['Periode berjalan', periodLabel(current)],
    ['Sudah lunas periode ini', `${statusNow.paid.length} dari ${i.members.length} anggota`],
    ['Belum lunas periode ini', `${statusNow.unpaid.length} anggota`],
    [],
    ['Cara pakai'],
    ['• Semua tab diisi otomatis oleh MIC-Bot dari catatan kas kelas; jangan diedit (Google akan memberi peringatan).'],
    ['• Catatan sendiri? Buat tab baru — tab itu tidak disentuh bot.'],
    ['• Pengeluaran / pemasukan lain dicatat lewat /kas keluar dan /kas masuk di Discord.'],
    ['• Siapa yang belum bayar: tab Status Iuran. Klik ikon filter di baris judul untuk menyaring (mis. per anggota atau periode).'],
    [],
    [MARKER_LABEL, i.marker],
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
    const st = paidStatus(i.members, i.entries, rate, p);
    return new Map([...st.paid, ...st.unpaid].map((s) => [s.id, s.paidAmount]));
  });
  for (const m of [...i.members].sort((a, b) => a.name.localeCompare(b.name))) {
    const now = statusNow.paid.find((s) => s.id === m.id) ? 'Lunas' : `Kurang ${rupiah(rate(current) - (perPeriod.at(-1)!.get(m.id) ?? 0))}`;
    status.push([m.name, ...perPeriod.map((map) => map.get(m.id) || ''), now]);
  }

  const bukti: Cell[][] = [['Dikirim', 'Anggota', 'Nominal', 'Periode', 'Status', 'Catatan otomatis']];
  for (const p of [...i.proofs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    bukti.push([formatWIB(p.createdAt, 'iso'), p.memberName, p.nominal ?? '', periodLabel(p.period), STATUS_LABEL[p.status] ?? p.status, p.flags.map((f) => `• ${i.flagText(f)}`).join('\n')]);
  }

  const jejak: Cell[][] = [['Waktu', 'Oleh', 'Tindakan', 'Detail']];
  for (const a of i.audits ?? []) jejak.push([formatWIB(a.at, 'iso'), a.actorName, ACTION_LABEL[a.action] ?? a.action, a.detail]);

  return [
    { title: 'Ringkasan', rows: ringkasan, table: false, moneyCols: [1], widths: [210, 200] },
    { title: 'Buku Kas', rows: bukuKas, table: true, moneyCols: [4, 5, 6], widths: [135, 200, 115, 125, 105, 105, 110, 240] },
    {
      title: 'Status Iuran',
      rows: status,
      table: true,
      moneyCols: periods.map((_, k) => k + 1),
      status: { col: periods.length + 1, good: ['Lunas'], bad: ['Kurang'] },
      widths: [180, ...periods.map(() => 115), 170],
    },
    { title: 'Bukti Transfer', rows: bukti, table: true, moneyCols: [2], status: { col: 4, good: ['Disetujui'], wait: ['Menunggu'], bad: ['Ditolak'] }, widths: [135, 180, 105, 125, 120, 420] },
    { title: 'Jejak Audit', rows: jejak, table: true, widths: [135, 170, 170, 420] },
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
