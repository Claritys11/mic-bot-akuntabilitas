import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MARKER_LABEL, type SheetTab } from '../../core/kas/sheet.ts';

// Google Sheets lewat akun layanan (service account) — tanpa library googleapis yang besar.
// Alur: JWT ditandatangani kunci privat akun layanan → token akses (1 jam) → REST API Sheets v4.
// Akun layanan tidak punya kuota Drive sendiri, jadi spreadsheet DIBUAT pengurus lalu dibagikan
// (Editor) ke email akun layanan; bot yang mengisi dan memperbaruinya.

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

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

type Fetch = typeof fetch;

export class SheetsClient {
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly http: Fetch = fetch,
  ) {}

  get serviceEmail(): string {
    return this.sa.client_email;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await this.http(this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
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

  /** Cek akses → judul spreadsheet. 403/404 = belum dibagikan ke akun layanan / link salah. */
  async check(spreadsheetId: string): Promise<{ ok: true; title: string; marker: string | null } | { ok: false; reason: string }> {
    try {
      const id = encodeURIComponent(spreadsheetId);
      const r = await this.call<{ properties: { title: string } }>(`${id}?fields=properties.title`);
      return { ok: true, title: r.properties.title, marker: await this.readMarker(spreadsheetId) };
    } catch (err) {
      const status = err instanceof SheetsError ? err.status : 0;
      if (status === 403) return { ok: false, reason: `belum dibagikan ke ${this.serviceEmail} sebagai Editor` };
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
