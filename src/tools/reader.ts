import type { PageReader } from '../core/opps/importer.ts';
import { htmlToText, parseFeed, safeFetch } from './web.ts';

/** PageReader nyata: ambil lewat safeFetch (aman SSRF), ubah ke teks/feed. */
export const webReader: PageReader = {
  async page(url) {
    const p = await safeFetch(url);
    const { title, text } = htmlToText(p.body);
    return { url: p.url, title, text };
  },
  async feed(url) {
    const p = await safeFetch(url);
    return parseFeed(p.body).map((i) => ({ title: i.title, link: i.link, summary: i.summary }));
  },
};
