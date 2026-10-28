import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MARKER_LABEL, type SheetTab } from '../../core/kas/sheet.ts';

// Google Sheets REST v4 tanpa library googleapis yang besar. Token akses dari TokenSource:
//   • login Google pengurus (oauth.ts) — sheet dibuat bot di Drive pengurus (cara utama), atau
//   • akun layanan — JWT bertanda tangan; sheet dibuat pengurus lalu dibagikan (Editor) ke email akun layanan,
//     karena akun layanan tidak punya kuota Drive sendiri.

// spreadsheets: isi sheet. drive.metadata.readonly: hanya membaca izin berbagi (tolak sheet yang publik).
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export const PUBLIC_REASON =
  'sheet ini bisa dibuka siapa saja yang punya link — isinya nama & status bayar anggota. Ubah Akses umum jadi "Dibatasi" dulu';

export class SheetsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function loadServiceAccount(path: string): Promise<ServiceAccount> {
  const sa = JSON.parse(await readFile(path, 'utf8')) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error('File akun layanan Google tidak valid (butuh client_email & private_key)');
  return sa;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** JWT bertanda tangan RS256 untuk ditukar dengan token akses (OAuth 2.0 JWT bearer). */
export function signedAssertion(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key, 'base64url');
  return `${header}.${claims}.${signature}`;
}

export type Fetch = typeof fetch;

/** Sumber token akses: akun layanan (cara lama) atau login Google pengurus (lihat oauth.ts). */
export interface TokenSource {
  accessToken(http: Fetch): Promise<string>;
  /** Kalimat untuk error 403, mis. "bagikan ke x@… sebagai Editor". */
  readonly deniedHint: string;
  /** Email akun layanan (hanya cara lama). */
  readonly serviceEmail?: string;
}

/** Token dari akun layanan: JWT bertanda tangan → token akses 1 jam (di-cache). */
export class ServiceAccountTokens implements TokenSource {
  private token: { value: string; until: number } | null = null;
  constructor(private readonly sa: ServiceAccount) {}

  get serviceEmail(): string {
    return this.sa.client_email;
  }

  get deniedHint(): string {
    return `belum dibagikan ke ${this.sa.client_email} sebagai Editor`;
  }

  async accessToken(http: Fetch): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await http(this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(this.sa) }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !data.access_token) throw new SheetsError(res.status, `Login Google gagal: ${data.error_description ?? res.status}`);
    this.token = { value: data.access_token, until: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 };
    return this.token.value;
  }
}

export class SheetsClient {
  private readonly auth: TokenSource;

  constructor(
    auth: ServiceAccount | TokenSource,
    private readonly http: Fetch = fetch,
  ) {
    this.auth = 'private_key' in auth ? new ServiceAccountTokens(auth) : auth;
  }

  /** Email akun layanan (kosong kalau sheet milik login Google pengurus). */
  get serviceEmail(): string {
    return this.auth.serviceEmail ?? '';
  }

  get deniedHint(): string {
    return this.auth.deniedHint;
  }

  private accessToken(): Promise<string> {
    return this.auth.accessToken(this.http);
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.http(`${API}/${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new SheetsError(res.status, data.error?.message ?? `Google Sheets HTTP ${res.status}`);
    return data;
  }

  /**
   * Siapa saja yang bisa membuka file ini. Sheet berisi nama anak & status bayar → kalau "siapa saja yang
   * punya link" / satu domain bisa membuka, bot menolak menulis. Error (mis. Drive API belum aktif) → dilempar
   * (gagal tertutup).
   */
  async publicAccess(spreadsheetId: string): Promise<'private' | 'anyone' | 'domain'> {
    const res = await this.http(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=permissions(type,role)&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(10_000) },
    );
    const data = (await res.json().catch(() => ({}))) as { permissions?: { type: string }[]; error?: { message?: string } };
    if (!res.ok) throw new SheetsError(res.status, `Tidak bisa memeriksa izin berbagi: ${data.error?.message ?? res.status} (aktifkan Google Drive API di project)`);
    const types = new Set((data.permissions ?? []).map((p) => p.type));
    return types.has('anyone') ? 'anyone' : types.has('domain') ? 'domain' : 'private';
  }

  /** Cek akses → judul spreadsheet. 403/404 = belum dibagikan ke akun layanan / link salah. */
  async check(spreadsheetId: string): Promise<{ ok: true; title: string; marker: string | null } | { ok: false; reason: string }> {
    try {
      const id = encodeURIComponent(spreadsheetId);
      const r = await this.call<{ properties: { title: string } }>(`${id}?fields=properties.title`);
      const access = await this.publicAccess(spreadsheetId);
      if (access !== 'private') return { ok: false, reason: PUBLIC_REASON };
      return { ok: true, title: r.properties.title, marker: await this.readMarker(spreadsheetId) };
    } catch (err) {
      const status = err instanceof SheetsError ? err.status : 0;
      if (status === 403) return { ok: false, reason: this.deniedHint };
      if (status === 404) return { ok: false, reason: 'spreadsheet tidak ditemukan — cek lagi linknya' };
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * Penanda kelas di tab Ringkasan. null HANYA kalau tab itu memang belum ada (400 "Unable to parse range");
   * error lain dilempar → pemanggil menolak (gagal tertutup, jangan sampai menimpa sheet kelas lain).
   */
  async readMarker(spreadsheetId: string): Promise<string | null> {
    try {
      const v = await this.call<{ values?: string[][] }>(`${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent("'Ringkasan'!A1:B40")}`);
      return (v.values ?? []).find((row) => row[0] === MARKER_LABEL)?.[1] ?? null;
    } catch (err) {
      if (err instanceof SheetsError && err.status === 400 && /parse range/i.test(err.message)) return null;
      throw err;
    }
  }

  /** Tulis ulang tab-tab milik bot (dibuat kalau belum ada). Nilai ditulis RAW → tidak ada formula yang dieksekusi. */
  async writeTabs(spreadsheetId: string, tabs: SheetTab[]): Promise<void> {
    const id = encodeURIComponent(spreadsheetId);
    const meta = await this.call<{ sheets: SheetMeta[] }>(
      `${id}?fields=sheets(properties(sheetId,title),bandedRanges(bandedRangeId),conditionalFormats(ranges(sheetId)),protectedRanges(protectedRangeId,description))`,
    );
    const existing = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    const missing = tabs.filter((t) => !existing.has(t.title));
    if (missing.length) {
      const added = await this.call<{ replies: { addSheet: { properties: { sheetId: number; title: string } } }[] }>(`${id}:batchUpdate`, {
        method: 'POST',
        body: { requests: missing.map((t) => ({ addSheet: { properties: { title: t.title } } })) },
      });
      for (const r of added.replies) existing.set(r.addSheet.properties.title, r.addSheet.properties.sheetId);
    }
    const range = (t: string) => `'${t.replace(/'/g, "''")}'`;
    await this.call(`${id}/values:batchClear`, { method: 'POST', body: { ranges: tabs.map((t) => range(t.title)) } });
    await this.call(`${id}/values:batchUpdate`, {
      method: 'POST',
      body: { valueInputOption: 'RAW', data: tabs.map((t) => ({ range: `${range(t.title)}!A1`, values: t.rows })) },
    });
    // Tampilan (rupiah, warna, filter). Gagal di sini tidak menggagalkan data yang sudah tertulis.
    await this.call(`${id}:batchUpdate`, { method: 'POST', body: { requests: formatRequests(tabs, existing, meta.sheets) } }).catch((err: Error) =>
      console.warn(`[sheets] format tampilan gagal: ${err.message}`),
    );
  }
}

interface SheetMeta {
  properties: { sheetId: number; title: string };
  bandedRanges?: { bandedRangeId: number }[];
  conditionalFormats?: unknown[];
  protectedRanges?: { protectedRangeId: number; description?: string }[];
}

const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const COLOR = {
  header: rgb('#1E5B4F'),
  headerText: rgb('#FFFFFF'),
  band: rgb('#F1F6F4'),
  white: rgb('#FFFFFF'),
  title: rgb('#1E5B4F'),
  muted: rgb('#6B7280'),
  good: rgb('#D9F2E3'),
  goodText: rgb('#14532D'),
  wait: rgb('#FEF3C7'),
  waitText: rgb('#78350F'),
  bad: rgb('#FDE2E1'),
  badText: rgb('#7F1D1D'),
};
const MONEY = { type: 'CURRENCY', pattern: '"Rp"#,##0;-"Rp"#,##0;"Rp"0' };
export const PROTECT_NOTE = 'Diisi otomatis oleh MIC-Bot';

/**
 * Permintaan batchUpdate untuk merapikan tab buatan bot. Diterapkan ulang tiap sinkron (jumlah baris
 * berubah), jadi pita warna & aturan warna lama dihapus dulu supaya tidak menumpuk.
 */
export function formatRequests(tabs: SheetTab[], ids: Map<string, number>, meta: SheetMeta[]): object[] {
  const out: object[] = [];
  for (const t of tabs) {
    const sheetId = ids.get(t.title);
    if (sheetId === undefined) continue;
    const old = meta.find((m) => m.properties.sheetId === sheetId);
    for (const b of old?.bandedRanges ?? []) out.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
    for (let k = (old?.conditionalFormats ?? []).length - 1; k >= 0; k--) out.push({ deleteConditionalFormatRule: { sheetId, index: k } });

    const rows = Math.max(t.rows.length, 1);
    const cols = Math.max(1, ...t.rows.map((r) => r.length));
    const area = (r0: number, r1: number, c0 = 0, c1 = cols) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
    const fmt = (r: object, format: object, fields: string) => out.push({ repeatCell: { range: r, cell: { userEnteredFormat: format }, fields } });

    out.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: t.table ? 1 : 0, hideGridlines: !t.table }, tabColorStyle: { rgbColor: t.table ? COLOR.band : COLOR.header } },
        fields: 'gridProperties(frozenRowCount,hideGridlines),tabColorStyle',
      },
    });
    // Mulai dari bersih (sisa format dari isi lama yang lebih panjang), lalu font & perataan dasar.
    // Tabel: teks panjang dibungkus di kolom berlebar tetap, bukan meluber ke kanan.
    fmt({ sheetId }, { verticalAlignment: 'MIDDLE', wrapStrategy: t.table ? 'WRAP' : 'OVERFLOW_CELL', textFormat: { fontSize: 10 } }, 'userEnteredFormat');

    if (t.table) {
      fmt(area(0, 1), { backgroundColor: COLOR.header, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP', textFormat: { bold: true, foregroundColor: COLOR.headerText } }, 'userEnteredFormat');
      out.push({
        addBanding: { bandedRange: { range: area(0, rows), rowProperties: { headerColor: COLOR.header, firstBandColor: COLOR.white, secondBandColor: COLOR.band } } },
      });
      out.push({ setBasicFilter: { filter: { range: area(0, rows) } } });
      out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 32 }, fields: 'pixelSize' } });
    } else {
      out.push({ clearBasicFilter: { sheetId } });
      // Ringkasan: judul besar, kolom label tebal, keterangan abu-abu.
      fmt(area(0, 1, 0, 1), { textFormat: { bold: true, fontSize: 16, foregroundColor: COLOR.title } }, 'userEnteredFormat.textFormat');
      fmt(area(1, 2, 0, 1), { textFormat: { italic: true, foregroundColor: COLOR.muted } }, 'userEnteredFormat.textFormat');
      t.rows.forEach((r, k) => {
        if (k < 2 || r.length === 0) return;
        if (r.length === 1 && String(r[0]).startsWith('•')) fmt(area(k, k + 1, 0, 1), { textFormat: { foregroundColor: COLOR.muted } }, 'userEnteredFormat.textFormat');
        else fmt(area(k, k + 1, 0, 1), { textFormat: { bold: true } }, 'userEnteredFormat.textFormat');
        if (r.length > 1 && typeof r[1] === 'number') fmt(area(k, k + 1, 1, 2), { textFormat: { bold: true, fontSize: 12 } }, 'userEnteredFormat.textFormat');
      });
    }

    const first = t.table ? 1 : 0;
    for (const c of t.moneyCols ?? []) fmt(area(first, rows, c, c + 1), { numberFormat: MONEY, horizontalAlignment: 'RIGHT' }, 'userEnteredFormat(numberFormat,horizontalAlignment)');

    if (t.status) {
      const r = area(1, Math.max(rows, 2), t.status.col, t.status.col + 1);
      const rule = (words: string[], bg: object, fg: object) =>
        words.map((w) => ({
          addConditionalFormatRule: {
            index: 0,
            rule: { ranges: [r], booleanRule: { condition: { type: 'TEXT_STARTS_WITH', values: [{ userEnteredValue: w }] }, format: { backgroundColor: bg, textFormat: { bold: true, foregroundColor: fg } } } },
          },
        }));
      out.push(...rule(t.status.good, COLOR.good, COLOR.goodText), ...rule(t.status.wait ?? [], COLOR.wait, COLOR.waitText), ...rule(t.status.bad, COLOR.bad, COLOR.badText));
    }

    if (t.widths) {
      t.widths.forEach((px, c) => out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } }));
    } else {
      out.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } });
    }

    // Edit tab buatan bot → Google memberi peringatan dulu (tidak dikunci: pemilik tetap bebas).
    if (!(old?.protectedRanges ?? []).some((p) => p.description === PROTECT_NOTE)) {
      out.push({ addProtectedRange: { protectedRange: { range: { sheetId }, description: PROTECT_NOTE, warningOnly: true } } });
    }
  }
  return out;
}
