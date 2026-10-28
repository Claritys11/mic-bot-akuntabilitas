import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SheetsClient, SheetsError, type Fetch, type TokenSource } from './sheets.ts';

// Login Google pengurus lewat kode (OAuth 2.0 device flow, seperti login di TV):
//   bot minta kode → pengurus buka google.com/device, masukkan kode, pilih akun, Izinkan
//   → bot dapat refresh token → bot MEMBUAT spreadsheet di Drive pengurus sendiri.
// Scope hanya drive.file: bot cuma bisa menyentuh file yang ia buat, bukan isi Drive lainnya.
// Refresh token disegel AES-256-GCM sebelum keluar dari modul ini; core hanya melihat string tersegel.

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const keyOf = (secret: string) => createHash('sha256').update(secret).digest();

/** Segel rahasia: "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function sealSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Buka segel; kunci salah / isi diubah → throw. */
export function openSecret(sealed: string, secret: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('kredensial tidak dikenali');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export type PollResult =
  | { status: 'ok'; credential: string }
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired' }
  | { status: 'error'; message: string };

export interface DeviceLinkerConfig {
  clientId: string;
  clientSecret: string;
  /** Kunci penyegel token (env SECRET_KEY). */
  secretKey: string;
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params),
  signal: AbortSignal.timeout(10_000),
});

/** Token akses dari refresh token tersegel (di-cache sampai hampir kedaluwarsa). */
class RefreshTokens implements TokenSource {
  private token: { value: string; until: number } | null = null;
  readonly deniedHint = 'izin Google untuk sheet ini dicabut — sambungkan ulang lewat `/kas sheet`';

  constructor(
    private readonly cfg: DeviceLinkerConfig,
    private readonly credential: string,
  ) {}

  async accessToken(http: Fetch): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await http(TOKEN_URL, form({ grant_type: 'refresh_token', refresh_token: openSecret(this.credential, this.cfg.secretKey), client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }));
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    // invalid_grant = pengguna mencabut akses / token kedaluwarsa → perlakukan seperti 403.
    if (!res.ok || !data.access_token) throw new SheetsError(data.error === 'invalid_grant' ? 403 : res.status, `Login Google gagal: ${data.error ?? res.status}`);
    this.token = { value: data.access_token, until: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 };
    return this.token.value;
  }
}

const LOCALES = ['in_ID', 'id_ID'];

export class GoogleDeviceLinker {
  private readonly clients = new Map<string, SheetsClient>();

  constructor(
    private readonly cfg: DeviceLinkerConfig,
    private readonly http: Fetch = fetch,
  ) {}

  async start(): Promise<DeviceStart> {
    const res = await this.http(DEVICE_URL, form({ client_id: this.cfg.clientId, scope: DRIVE_FILE_SCOPE }));
    const d = (await res.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_url?: string; expires_in?: number; interval?: number; error?: string };
    if (!res.ok || !d.device_code || !d.user_code) throw new Error(`Google menolak permintaan kode: ${d.error ?? res.status}`);
    return { deviceCode: d.device_code, userCode: d.user_code, verificationUrl: d.verification_url ?? 'https://www.google.com/device', expiresIn: d.expires_in ?? 1800, interval: d.interval ?? 5 };
  }

  async poll(deviceCode: string): Promise<PollResult> {
    const res = await this.http(
      TOKEN_URL,
      form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    );
    const d = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
    if (res.ok) {
      if (!d.refresh_token) return { status: 'error', message: 'Google tidak memberi izin jangka panjang' };
      return { status: 'ok', credential: sealSecret(d.refresh_token, this.cfg.secretKey) };
    }
    if (d.error === 'authorization_pending') return { status: 'pending' };
    if (d.error === 'slow_down') return { status: 'slow_down' };
    if (d.error === 'access_denied') return { status: 'denied' };
    if (d.error === 'expired_token') return { status: 'expired' };
    return { status: 'error', message: d.error_description ?? d.error ?? `HTTP ${res.status}` };
  }

  /** Klien Sheets yang memakai login pengurus kelas ini (di-cache per kredensial). */
  clientFor(credential: string): SheetsClient {
    let c = this.clients.get(credential);
    if (!c) {
      c = new SheetsClient(new RefreshTokens(this.cfg, credential), this.http);
      this.clients.set(credential, c);
    }
    return c;
  }

  /** Spreadsheet baru di Drive pengurus (default: hanya pemilik yang bisa membuka). */
  async createSheet(credential: string, title: string, tabs: readonly string[]): Promise<{ id: string; title: string }> {
    const token = await new RefreshTokens(this.cfg, credential).accessToken(this.http);
    // Locale Indonesia (pemisah ribuan titik) — kodenya tidak konsisten antar layanan Google, jadi dicoba
    // berurutan; kalau semua ditolak, pakai bawaan akun (cuma memengaruhi tampilan angka).
    for (const locale of [...LOCALES, null]) {
      const res = await this.http(SHEETS_API, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          properties: { title, timeZone: 'Asia/Jakarta', ...(locale ? { locale } : {}) },
          sheets: tabs.map((t) => ({ properties: { title: t } })),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const d = (await res.json().catch(() => ({}))) as { spreadsheetId?: string; properties?: { title?: string }; error?: { message?: string } };
      if (res.ok && d.spreadsheetId) return { id: d.spreadsheetId, title: d.properties?.title ?? title };
      if (locale && res.status === 400 && /locale/i.test(d.error?.message ?? '')) continue;
      throw new SheetsError(res.status, d.error?.message ?? `Gagal membuat spreadsheet (HTTP ${res.status})`);
    }
    throw new SheetsError(400, 'Gagal membuat spreadsheet');
  }

  /** Cabut izin di Google (saat diputus). Gagal → diabaikan; token tersegel tetap dihapus pemanggil. */
  async revoke(credential: string): Promise<void> {
    this.clients.delete(credential);
    await this.http(REVOKE_URL, form({ token: openSecret(credential, this.cfg.secretKey) })).catch(() => undefined);
  }
}
