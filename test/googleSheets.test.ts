import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { SheetsClient, signedAssertion } from '../src/integrations/google/sheets.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'mic-bot@proyek.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

describe('JWT akun layanan', () => {
  test('ditandatangani RS256 & berisi scope spreadsheets', () => {
    const [h, c, s] = signedAssertion(sa, 1_800_000_000).split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, s!, 'base64url')).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', exp: 1_800_003_600 });
  });
});

function fakeGoogle(opts: { status?: number; sheets?: string[]; markerStatus?: number } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u.includes('oauth2')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (opts.status) return json(opts.status, { error: { message: 'denied' } });
    if (u.includes('fields=properties.title')) return json(200, { properties: { title: 'Kas XI RPL 1' } });
    if (u.includes('/values/')) return opts.markerStatus ? json(opts.markerStatus, { error: { message: opts.markerStatus === 400 ? 'Unable to parse range: Ringkasan' : 'quota' } }) : json(200, { values: [['ID kelas (jangan diubah)', 'MIC-X']] });
    if (u.includes('fields=sheets')) return json(200, { sheets: (opts.sheets ?? []).map((t, i) => ({ properties: { sheetId: i, title: t } })) });
    if (u.endsWith(':batchUpdate') && calls.filter((c) => c.url.endsWith(':batchUpdate')).length === 1 && (opts.sheets ?? []).length < 2)
      return json(200, { replies: [{ addSheet: { properties: { sheetId: 9, title: 'Buku Kas' } } }] });
    return json(200, {});
  }) as typeof fetch;
  return { http, calls };
}

describe('klien Google Sheets', () => {
  test('cek akses: berhasil → judul; 403 → minta dibagikan ke email akun layanan', async () => {
    expect(await new SheetsClient(sa, fakeGoogle().http).check('abc')).toEqual({ ok: true, title: 'Kas XI RPL 1', marker: 'MIC-X' });
    expect(await new SheetsClient(sa, fakeGoogle({ markerStatus: 400 }).http).check('abc')).toEqual({ ok: true, title: 'Kas XI RPL 1', marker: null });
    // Error lain saat membaca penanda → tolak (gagal tertutup), jangan dianggap sheet kosong.
    expect((await new SheetsClient(sa, fakeGoogle({ markerStatus: 429 }).http).check('abc')).ok).toBe(false);
    const denied = await new SheetsClient(sa, fakeGoogle({ status: 403 }).http).check('abc');
    expect(denied).toEqual({ ok: false, reason: `belum dibagikan ke ${sa.client_email} sebagai Editor` });
  });
  test('tulis: tab yang belum ada dibuat, dikosongkan, lalu diisi RAW (formula tidak dieksekusi)', async () => {
    const g = fakeGoogle({ sheets: ['Ringkasan'] });
    await new SheetsClient(sa, g.http).writeTabs('abc', [
      { title: 'Ringkasan', rows: [['Saldo', 1000]] },
      { title: 'Buku Kas', rows: [['=HYPERLINK("x")', 5]] },
    ]);
    const add = g.calls.find((c) => c.url.endsWith(':batchUpdate'))!.body as { requests: { addSheet: { properties: { title: string } } }[] };
    expect(add.requests.map((r) => r.addSheet.properties.title)).toEqual(['Buku Kas']);
    expect(g.calls.some((c) => c.url.endsWith('values:batchClear'))).toBe(true);
    const write = g.calls.find((c) => c.url.endsWith('values:batchUpdate'))!.body as { valueInputOption: string; data: { range: string }[] };
    expect(write.valueInputOption).toBe('RAW');
    expect(write.data.map((d) => d.range)).toEqual(["'Ringkasan'!A1", "'Buku Kas'!A1"]);
    expect(g.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1); // token dipakai ulang
  });
});
