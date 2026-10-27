import { describe, expect, test } from 'bun:test';
import { FetchRefused, htmlToText, isBlockedAddress, parseFeed, safeFetch } from '../src/tools/web.ts';

describe('cegah SSRF', () => {
  test.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])('%s ditolak', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  test.each(['104.21.3.4', '8.8.8.8', '2606:4700::1111'])('%s boleh', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
  test.each(['http://example.com', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://example.com:8443/', 'https://user:pw@example.com/', 'file:///etc/passwd', 'bukan url'])(
    '%s tidak diambil',
    async (url) => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(FetchRefused);
    },
  );
});

describe('HTML → teks', () => {
  test('ambil og:title, buang skrip & navigasi', () => {
    const r = htmlToText(
      '<html><head><title>x</title><meta property="og:title" content="Lomba Web Kampus X 2026"></head><body><nav>menu</nav><script>alert(1)</script><article><h1>Lomba</h1><p>Deadline&nbsp;5 Des 2026</p></article></body></html>',
    );
    expect(r.title).toBe('Lomba Web Kampus X 2026');
    expect(r.text).toContain('Deadline 5 Des 2026');
    expect(r.text).not.toMatch(/alert|menu/);
  });
});

describe('feed RSS/Atom', () => {
  test('RSS 2.0 dengan CDATA & kategori', () => {
    const items = parseFeed(`<rss><channel><item><title><![CDATA[Lomba UI/UX &amp; Web]]></title><link>https://lombasma.com/a/</link><pubDate>Mon, 02 Nov 2026 01:00:00 +0000</pubDate><category><![CDATA[Info Lomba SMA]]></category><description><![CDATA[<p>Pendaftaran s.d. 30 Nov</p>]]></description></item>
      <item><title>Tanpa https</title><link>http://x.com/b</link></item></channel></rss>`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Lomba UI/UX & Web', link: 'https://lombasma.com/a/', categories: ['Info Lomba SMA'], summary: 'Pendaftaran s.d. 30 Nov' });
  });
  test('Atom', () => {
    const items = parseFeed(`<feed><entry><title>Beasiswa X</title><link rel="alternate" href="https://beasiswa.id/x"/><updated>2026-11-01</updated><summary>Untuk siswa SMK</summary></entry></feed>`);
    expect(items[0]).toMatchObject({ title: 'Beasiswa X', link: 'https://beasiswa.id/x', published: '2026-11-01' });
  });
});
