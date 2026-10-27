import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Ambil halaman web dengan aman. URL bisa berasal dari pengguna ("ada lomba nih <link>"), jadi:
//  • hanya https, port standar
//  • host yang mengarah ke IP privat/loopback/link-local ditolak (cegah SSRF ke jaringan dalam)
//  • redirect diikuti manual (maks 3), tiap langkah dicek ulang
//  • batas waktu & ukuran; hanya teks (HTML/XML/RSS)
// Catatan: DNS rebinding di antara cek dan koneksi masih mungkin secara teori; risiko kecil karena
// hasilnya hanya dibaca sebagai teks dan tidak pernah dikembalikan mentah ke pengguna.

export const MAX_PAGE_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
export const USER_AGENT = 'MIC-Bot/1.0 (bot info lomba kelas; +https://github.com/Claritys11/mic-bot-akuntabilitas)';

/** IPv4/IPv6 yang tidak boleh dihubungi: privat, loopback, link-local, CGNAT, multicast, dll. */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
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
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

export class FetchRefused extends Error {}

async function assertPublicUrl(raw: string): Promise<URL> {
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
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new FetchRefused('Domain tidak ditemukan');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new FetchRefused('Alamat tidak diizinkan');
  return url;
}

export interface FetchedPage {
  url: string;
  contentType: string;
  body: string;
}

export async function safeFetch(raw: string): Promise<FetchedPage> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new FetchRefused('Redirect tanpa tujuan');
      url = await assertPublicUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new FetchRefused(`Halaman membalas HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/|xml|rss|atom/i.test(type)) throw new FetchRefused('Bukan halaman teks');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_PAGE_BYTES) throw new FetchRefused('Halaman terlalu besar');
    const reader = res.body?.getReader();
    if (!reader) throw new FetchRefused('Halaman kosong');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel();
        throw new FetchRefused('Halaman terlalu besar');
      }
      chunks.push(value);
    }
    return { url: url.toString(), contentType: type, body: new TextDecoder().decode(Buffer.concat(chunks)) };
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
