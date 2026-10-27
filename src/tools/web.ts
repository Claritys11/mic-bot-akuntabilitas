import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

// Ambil halaman web dengan aman. URL bisa berasal dari pengguna ("ada lomba nih <link>"), jadi:
//  • hanya https, port standar, tanpa kredensial di URL
//  • setiap koneksi memakai lookup DNS sendiri yang menolak IP privat/loopback/link-local/dll. dan
//    MENGUNCI koneksi ke IP yang sudah dicek (cegah DNS rebinding) — termasuk di tiap redirect
//  • redirect diikuti manual (maks 3); batas waktu & ukuran; hanya teks (HTML/XML/RSS)

export const MAX_PAGE_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
export const USER_AGENT = 'MIC-Bot/1.0 (bot info lomba kelas; +https://github.com/Claritys11/mic-bot-akuntabilitas)';

function v4Blocked(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / metadata cloud
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** "::ffff:7f00:1", "::ffff:127.0.0.1", "fe80::1" → 8 bilangan 16-bit; null kalau bukan IPv6 valid. */
export function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const q = dotted.slice(1).map(Number);
    if (q.some((n) => n > 255)) return null;
    s = s.slice(0, -dotted[0].length) + `${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill(0), ...tail];
  return all.length === 8 && all.every((n) => Number.isInteger(n)) && (halves.length === 2 ? fill >= 1 : true) ? all : null;
}

/** IPv4/IPv6 yang tidak boleh dihubungi: privat, loopback, link-local, CGNAT, multicast, IPv4 tersisip, dll. */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return v4Blocked(a, b);
  }
  const h = expandIPv6(ip);
  if (!h) return true;
  const embedded = (hi: number, lo: number) => v4Blocked(hi >> 8, hi & 0xff) || (hi === 0 && lo === 0);
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), ::, ::1
    if (h[5] === 0 && h[6] === 0) return true; // ::, ::1, ::x
    return embedded(h[6]!, h[7]!) || h[5] === 0; // IPv4-compatible sudah usang → tolak
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // NAT64 → bisa menjangkau IPv4 dalam
  if (h[0] === 0x2002) return true; // 6to4 menyisipkan IPv4
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // dokumentasi
  if (h[0] === 0x2001 && h[1]! < 0x200) return true; // Teredo & rentang khusus 2001::/23
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xffc0) === 0xfec0) return true; // link/site-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard 100::/64
  return false;
}

export class FetchRefused extends Error {}

/** Lookup yang dipakai socket: resolve sekali, tolak kalau ADA alamat terlarang, kunci ke alamat yang dicek. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as { address: string; family: number }[];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return callback(new FetchRefused('Alamat tidak diizinkan'), '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused('URL tidak valid');
  }
  if (url.protocol !== 'https:') throw new FetchRefused('Hanya link https yang bisa dibaca');
  if (url.port && url.port !== '443') throw new FetchRefused('Port tidak diizinkan');
  if (url.username || url.password) throw new FetchRefused('URL berisi kredensial');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new FetchRefused('Alamat tidak diizinkan');
  if (isIP(host) && isBlockedAddress(host)) throw new FetchRefused('Alamat tidak diizinkan');
  return url;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Cek DNS sebelum koneksi (lapis pertama); lookup socket mengecek lagi & mengunci IP (lapis kedua). */
export async function assertResolvesPublic(host: string): Promise<void> {
  const addrs = isIP(host) ? [{ address: host }] : await dnsLookupAsync(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new FetchRefused('Domain tidak ditemukan');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new FetchRefused('Alamat tidak diizinkan');
}

function request(url: URL): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Batas waktu TOTAL (opsi timeout bawaan hanya untuk jeda antar-paket; server lambat bisa menahan lama).
    const deadline = setTimeout(() => req.destroy(new FetchRefused('Halaman terlalu lama merespons')), TIMEOUT_MS);
    const done = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(deadline);
      fn(v);
    };
    resolve = done(resolve);
    reject = done(reject);
    const req = https.request(
      {
        host,
        servername: isIP(host) ? undefined : host,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: guardedLookup,
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers['content-type'] ?? '');
        if (status >= 200 && status < 300 && !/text\/|xml|rss|atom/i.test(type)) {
          res.destroy();
          return reject(new FetchRefused(/pdf/i.test(type) ? 'linknya berupa PDF — aku baru bisa baca halaman web biasa' : 'linknya bukan halaman web biasa'));
        }
        if (Number(res.headers['content-length'] ?? 0) > MAX_PAGE_BYTES) {
          res.destroy();
          return reject(new FetchRefused('Halaman terlalu besar'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_PAGE_BYTES) {
            res.destroy();
            reject(new FetchRefused('Halaman terlalu besar'));
          } else chunks.push(c);
        });
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new FetchRefused('Halaman terlalu lama merespons')));
    req.on('error', (e) => {
      if (e instanceof FetchRefused) return reject(e);
      console.warn(`[web] ${url.hostname}: ${e.message}`);
      // Pesan untuk siswa, bukan istilah teknis (temuan QA T12).
      const code = (e as NodeJS.ErrnoException).code ?? '';
      reject(
        new FetchRefused(
          /CERT|SELF_SIGNED|certificate/i.test(`${code} ${e.message}`)
            ? 'situsnya tidak bisa dibuka dengan aman (sertifikatnya bermasalah)'
            : /ENOTFOUND|EAI_AGAIN/.test(code)
              ? 'alamat situsnya tidak ditemukan'
              : 'situsnya tidak bisa dibuka sekarang',
        ),
      );
    });
    req.end();
  });
}

export interface FetchedPage {
  url: string;
  contentType: string;
  body: string;
}

export async function safeFetch(raw: string): Promise<FetchedPage> {
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertResolvesPublic(url.hostname.replace(/^\[|\]$/g, ''));
    const res = await request(url);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      if (typeof loc !== 'string' || !loc) throw new FetchRefused('Redirect tanpa tujuan');
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new FetchRefused(`Halaman membalas HTTP ${res.status}`);
    return { url: url.toString(), contentType: String(res.headers['content-type'] ?? ''), body: res.body };
  }
  throw new FetchRefused('Terlalu banyak redirect');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** HTML → teks polos (judul + isi), tanpa skrip/gaya/navigasi. Dibatasi panjangnya untuk LLM. */
export function htmlToText(html: string, max = 12_000): { title: string; text: string } {
  const title = decodeEntities(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const main = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] ?? html;
  const text = decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return { title, text: text.slice(0, max) };
}

export interface FeedItem {
  title: string;
  link: string;
  published: string | null;
  summary: string;
  categories: string[];
}

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : '';
};

/** RSS 2.0 dan Atom → daftar item. Link hanya diterima kalau https. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocks
    .map((b) => {
      const atomLink = b.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
      const link = (tag(b, 'link') || atomLink || '').trim();
      return {
        title: tag(b, 'title').replace(/<[^>]+>/g, ''),
        link,
        published: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || null,
        summary: htmlToText(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded'), 1500).text,
        categories: [...b.matchAll(/<category(?:\s[^>]*term=["']([^"']+)["'])?[^>]*>(?:<!\[CDATA\[)?([^<\]]*)/gi)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean),
      };
    })
    .filter((i) => i.title && /^https:\/\//.test(i.link));
}
