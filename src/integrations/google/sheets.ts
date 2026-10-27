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
    const meta = await this.call<{ sheets: { properties: { sheetId: number; title: string } }[] }>(`${id}?fields=sheets.properties(sheetId,title)`);
    const existing = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    const missing = tabs.filter((t) => !existing.has(t.title));
    if (missing.length) {
      const added = await this.call<{ replies: { addSheet: { properties: { sheetId: number; title: string } } }[] }>(`${id}:batchUpdate`, {
        method: 'POST',
        body: { requests: missing.map((t) => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } })) },
      });
      for (const r of added.replies) existing.set(r.addSheet.properties.title, r.addSheet.properties.sheetId);
    }
    const range = (t: string) => `'${t.replace(/'/g, "''")}'`;
    await this.call(`${id}/values:batchClear`, { method: 'POST', body: { ranges: tabs.map((t) => range(t.title)) } });
    await this.call(`${id}/values:batchUpdate`, {
      method: 'POST',
      body: { valueInputOption: 'RAW', data: tabs.map((t) => ({ range: `${range(t.title)}!A1`, values: t.rows })) },
    });
    // Header tebal + kolom pas (sekadar rapi; gagal di sini tidak masalah).
    await this.call(`${id}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: tabs.flatMap((t) => {
          const sheetId = existing.get(t.title)!;
          return [
            { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
            { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 10 } } },
          ];
        }),
      },
    }).catch(() => undefined);
  }
}
