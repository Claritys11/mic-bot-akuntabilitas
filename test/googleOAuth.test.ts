import { describe, expect, test } from 'bun:test';
import { DRIVE_FILE_SCOPE, GoogleDeviceLinker, openSecret, sealSecret } from '../src/integrations/google/oauth.ts';

const KEY = 'kunci-rahasia-uji-yang-panjangnya-lebih-dari-32-karakter';

describe('penyimpanan token terenkripsi', () => {
  test('bolak-balik; tiap segel beda (IV acak); kunci lain / diubah → gagal', () => {
    const a = sealSecret('1//refresh-token', KEY);
    expect(a).not.toContain('refresh');
    expect(a).not.toBe(sealSecret('1//refresh-token', KEY));
    expect(openSecret(a, KEY)).toBe('1//refresh-token');
    expect(() => openSecret(a, `${KEY}-lain`)).toThrow();
    const [v, iv, tag, ct] = a.split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0]! ^= 1;
    expect(() => openSecret([v, iv, tag, flipped.toString('base64url')].join('.'), KEY)).toThrow();
  });
});

function fakeGoogle(tokenReplies: { status: number; body: unknown }[] = []) {
  const calls: { url: string; body: string }[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '';
    calls.push({ url: u, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (u.endsWith('/device/code')) return json(200, { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
    if (u.endsWith('/token')) {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') return json(200, { access_token: 'akses', expires_in: 3600 });
      const r = tokenReplies.shift() ?? { status: 428, body: { error: 'authorization_pending' } };
      return json(r.status, r.body);
    }
    if (u === 'https://sheets.googleapis.com/v4/spreadsheets' && JSON.parse(body).properties.locale === 'in_ID')
      return json(400, { error: { message: 'Invalid properties: Unsupported locale: in_ID' } });
    if (u === 'https://sheets.googleapis.com/v4/spreadsheets') return json(200, { spreadsheetId: 'SHEET123', properties: { title: JSON.parse(body).properties.title } });
    if (u.includes('/revoke')) return json(200, {});
    return json(200, {});
  }) as typeof fetch;
  return { http, calls };
}

const linker = (g: ReturnType<typeof fakeGoogle>) => new GoogleDeviceLinker({ clientId: 'cid', clientSecret: 'csec', secretKey: KEY }, g.http);

describe('login Google lewat kode (device flow)', () => {
  test('mulai: minta kode dengan scope drive.file saja (hanya file buatan bot)', async () => {
    const g = fakeGoogle();
    const s = await linker(g).start();
    expect(s).toEqual({ deviceCode: 'DEV', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresIn: 1800, interval: 5 });
    expect(new URLSearchParams(g.calls[0]!.body).get('scope')).toBe(DRIVE_FILE_SCOPE);
  });

  test('tunggu → pending / slow_down / ditolak / kedaluwarsa', async () => {
    const g = fakeGoogle([
      { status: 428, body: { error: 'authorization_pending' } },
      { status: 403, body: { error: 'slow_down' } },
      { status: 403, body: { error: 'access_denied' } },
      { status: 400, body: { error: 'expired_token' } },
    ]);
    const l = linker(g);
    expect((await l.poll('DEV')).status).toBe('pending');
    expect((await l.poll('DEV')).status).toBe('slow_down');
    expect((await l.poll('DEV')).status).toBe('denied');
    expect((await l.poll('DEV')).status).toBe('expired');
  });

  test('disetujui → kredensial terenkripsi (token mentah tidak pernah keluar)', async () => {
    const g = fakeGoogle([{ status: 200, body: { access_token: 'a', refresh_token: '1//rahasia', expires_in: 3600, scope: DRIVE_FILE_SCOPE } }]);
    const r = await linker(g).poll('DEV');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.credential).not.toContain('rahasia');
    expect(openSecret(r.credential, KEY)).toBe('1//rahasia');
  });

  test('disetujui tanpa refresh token → dianggap gagal (bot tidak bisa memperbarui sheet nanti)', async () => {
    const g = fakeGoogle([{ status: 200, body: { access_token: 'a', expires_in: 3600 } }]);
    expect((await linker(g).poll('DEV')).status).toBe('error');
  });

  test('buat spreadsheet berisi tab laporan kas di Drive pengguna', async () => {
    const g = fakeGoogle();
    const l = linker(g);
    const cred = sealSecret('1//rahasia', KEY);
    const made = await l.createSheet(cred, 'Kas XI RPL 1 (MIC-Bot)', ['Ringkasan', 'Buku Kas']);
    expect(made).toEqual({ id: 'SHEET123', title: 'Kas XI RPL 1 (MIC-Bot)' });
    const create = g.calls.find((c) => c.url === 'https://sheets.googleapis.com/v4/spreadsheets')!;
    // Locale ditolak Google → coba kode berikutnya, bukan gagal total.
    const creates = g.calls.filter((c) => c.url === 'https://sheets.googleapis.com/v4/spreadsheets').map((c) => JSON.parse(c.body).properties.locale);
    expect(creates).toEqual(['in_ID', 'id_ID']);
    expect(JSON.parse(create.body).sheets.map((s: { properties: { title: string } }) => s.properties.title)).toEqual(['Ringkasan', 'Buku Kas']);
    // Token akses diambil dari refresh token yang dibuka di sisi integrasi.
    expect(new URLSearchParams(g.calls.find((c) => c.url.endsWith('/token'))!.body).get('refresh_token')).toBe('1//rahasia');
  });

  test('putus → token dicabut di Google', async () => {
    const g = fakeGoogle();
    await linker(g).revoke(sealSecret('1//rahasia', KEY));
    expect(g.calls.some((c) => c.url.includes('/revoke') && c.body.includes('1%2F%2Frahasia'))).toBe(true);
  });

  test('klien Sheets per kelas memakai token kelas itu', async () => {
    const g = fakeGoogle();
    const client = linker(g).clientFor(sealSecret('1//rahasia', KEY));
    await client.readMarker('SHEET123');
    const sheetsCall = g.calls.find((c) => c.url.includes('/values/'));
    expect(sheetsCall).toBeDefined();
  });
});
