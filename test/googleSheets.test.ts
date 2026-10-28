import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { formatRequests, PROTECT_NOTE, SheetsClient, signedAssertion } from '../src/integrations/google/sheets.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'mic-bot@proyek.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

describe('JWT akun layanan', () => {
  test('ditandatangani RS256 & berisi scope spreadsheets', () => {
    const [h, c, s] = signedAssertion(sa, 1_800_000_000).split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, s!, 'base64url')).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: sa.client_email, exp: 1_800_003_600 });
    expect(claims.scope.split(' ')).toEqual(['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.metadata.readonly']);
  });
});

function fakeGoogle(opts: { status?: number; sheets?: string[]; markerStatus?: number; public?: boolean } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u.includes('oauth2')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('drive/v3')) return json(200, { permissions: [{ type: 'user' }, ...(opts.public ? [{ type: 'anyone' }] : [])] });
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
    // Sheet bisa dibuka siapa saja yang punya link → ditolak (isinya data anak).
    const pub = await new SheetsClient(sa, fakeGoogle({ public: true }).http).check('abc');
    expect(pub.ok === false && pub.reason).toContain('siapa saja');
    // Error lain saat membaca penanda → tolak (gagal tertutup), jangan dianggap sheet kosong.
    expect((await new SheetsClient(sa, fakeGoogle({ markerStatus: 429 }).http).check('abc')).ok).toBe(false);
    const denied = await new SheetsClient(sa, fakeGoogle({ status: 403 }).http).check('abc');
    expect(denied).toEqual({ ok: false, reason: `belum dibagikan ke ${sa.client_email} sebagai Editor` });
  });
  test('tulis: tab yang belum ada dibuat, dikosongkan, lalu diisi RAW (formula tidak dieksekusi)', async () => {
    const g = fakeGoogle({ sheets: ['Ringkasan'] });
    await new SheetsClient(sa, g.http).writeTabs('abc', [
      { title: 'Ringkasan', rows: [['Saldo', 1000]], table: false },
      { title: 'Buku Kas', rows: [['=HYPERLINK("x")', 5]], table: true },
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

describe('tampilan sheet', () => {
  const tabs = [
    { title: 'Status Iuran', rows: [['Anggota', 'Okt', 'Status'], ['Ani', 10000, 'Lunas']], table: true, moneyCols: [1], status: { col: 2, good: ['Lunas'], bad: ['Kurang'] } },
  ];
  const kinds = (reqs: object[]) => reqs.map((r) => Object.keys(r)[0]);
  test('tab baru: rupiah, warna status, filter, pita, peringatan edit', () => {
    const reqs = formatRequests(tabs, new Map([['Status Iuran', 7]]), [{ properties: { sheetId: 7, title: 'Status Iuran' } }]);
    expect(kinds(reqs)).toEqual(expect.arrayContaining(['addBanding', 'setBasicFilter', 'addConditionalFormatRule', 'addProtectedRange', 'autoResizeDimensions']));
    expect(JSON.stringify(reqs)).toContain('CURRENCY');
  });
  test('sinkron ulang: pita & aturan warna lama dihapus dulu, peringatan tidak dobel', () => {
    const meta = [{ properties: { sheetId: 7, title: 'Status Iuran' }, bandedRanges: [{ bandedRangeId: 3 }], conditionalFormats: [{}, {}], protectedRanges: [{ protectedRangeId: 1, description: PROTECT_NOTE }] }];
    const reqs = formatRequests(tabs, new Map([['Status Iuran', 7]]), meta);
    expect(reqs.slice(0, 3)).toEqual([{ deleteBanding: { bandedRangeId: 3 } }, { deleteConditionalFormatRule: { sheetId: 7, index: 1 } }, { deleteConditionalFormatRule: { sheetId: 7, index: 0 } }]);
    expect(kinds(reqs)).not.toContain('addProtectedRange');
  });
});
