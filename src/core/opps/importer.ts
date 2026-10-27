import { z } from 'zod';
import { FeedItemModel, OpportunityModel, type OpportunityDoc } from '../../db/models.ts';
import { OPP_TAGS, opportunityPrompt } from '../../llm/prompts/opportunity.ts';
import { chatJson, type LLMProvider } from '../../llm/provider.ts';
import { formatWIB, fromWIB } from '../time.ts';
import { sanitize } from '../types.ts';

// Ambil data lomba/beasiswa dari halaman web: link yang ditempel pengurus/siswa, atau feed RSS harian.
// Jaringan tidak dipanggil langsung di core — adapter memberi `PageReader` (lihat src/tools/web.ts).

export interface PageReader {
  /** Baca halaman (aman dari SSRF) → judul + teks polos. */
  page(url: string): Promise<{ url: string; title: string; text: string }>;
  /** Baca feed RSS/Atom → item. */
  feed(url: string): Promise<{ title: string; link: string; summary: string }[]>;
}

const Extracted = z.object({
  isOpportunity: z.boolean(),
  kind: z.enum(['lomba', 'beasiswa', 'lainnya']).catch('lainnya'),
  title: z.string().default(''),
  organizer: z.string().nullish(),
  deadline: z.string().nullish(),
  level: z.string().nullish(),
  tags: z.array(z.string()).catch([]),
  summary: z.string().default(''),
  fee: z.string().nullish(),
});
export type ExtractedOpportunity = z.infer<typeof Extracted>;

const clean = (s: string | null | undefined, max: number) => (s ? sanitize(s.replace(/\s+/g, ' ').trim()).slice(0, max) : '');

/** Tanggal "YYYY-MM-DD" → 23:59 WIB hari itu; null kalau tidak valid. */
export function deadlineOf(s: string | null | undefined): Date | null {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = fromWIB(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Ubah hasil LLM jadi field Opportunity yang aman, atau alasan penolakan. */
export function normalizeExtraction(x: ExtractedOpportunity, now: Date): { ok: true; data: Omit<NormalizedOpp, 'link'> } | { ok: false; reason: string } {
  if (!x.isOpportunity || x.kind === 'lainnya') return { ok: false, reason: 'halaman ini sepertinya bukan info satu lomba/beasiswa' };
  const title = clean(x.title, 120);
  if (title.length < 4) return { ok: false, reason: 'judulnya tidak terbaca' };
  const deadline = deadlineOf(x.deadline);
  if (!deadline) return { ok: false, reason: 'deadline pendaftarannya tidak tertulis jelas' };
  if (deadline <= now) return { ok: false, reason: 'pendaftarannya sudah tutup' };
  if (x.level && /mahasiswa|sd\/smp/i.test(x.level)) return { ok: false, reason: `untuk jenjang ${x.level}, bukan SMA/SMK` };
  const allowed = new Set<string>(OPP_TAGS);
  const tags = [...new Set(x.tags.map((t) => t.toLowerCase().trim()).filter((t) => allowed.has(t)))].slice(0, 5);
  if (x.kind === 'beasiswa' && !tags.includes('beasiswa')) tags.push('beasiswa');
  return {
    ok: true,
    data: {
      title,
      organizer: clean(x.organizer, 80) || '-',
      deadline,
      tags: tags.length ? tags : ['umum'],
      description: clean(x.summary, 200),
      kind: x.kind,
      fee: x.fee === 'gratis' || x.fee === 'berbayar' ? x.fee : null,
      level: x.level ? clean(x.level, 20) : 'SMA/SMK',
    },
  };
}

export interface NormalizedOpp {
  title: string;
  organizer: string;
  deadline: Date;
  tags: string[];
  description: string;
  kind: 'lomba' | 'beasiswa';
  fee: string | null;
  level: string;
  link: string;
}

export async function extractFromPage(llm: LLMProvider, page: { url: string; title: string; text: string }, now: Date) {
  if (!llm.enabled) return { ok: false as const, reason: 'pembaca AI belum aktif' };
  const x = await chatJson(llm, Extracted, opportunityPrompt({ url: page.url, title: page.title, text: page.text, todayWIB: formatWIB(now) }), { maxTokens: 500 });
  if (!x) return { ok: false as const, reason: 'isi halaman tidak bisa dibaca' };
  const n = normalizeExtraction(x, now);
  return n.ok ? { ok: true as const, data: { ...n.data, link: page.url } } : n;
}

/**
 * Link dari pengurus/siswa → draf (belum tampil) untuk disetujui pengurus.
 * Mengembalikan draf, atau alasan kalau tidak bisa dibuat.
 */
export async function importLinkAsDraft(
  llm: LLMProvider,
  reader: PageReader,
  input: { url: string; groupId: string; addedBy: string; now: Date },
): Promise<{ ok: true; doc: OpportunityDoc; duplicate: boolean } | { ok: false; reason: string }> {
  const existing = await OpportunityModel.findOne({ link: input.url, groupId: { $in: [null, input.groupId] }, draft: { $ne: true } }).lean<OpportunityDoc>();
  if (existing) return { ok: true, doc: existing, duplicate: true };
  let page;
  try {
    page = await reader.page(input.url);
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'halaman tidak bisa dibuka' };
  }
  const r = await extractFromPage(llm, page, input.now);
  if (!r.ok) return r;
  const doc = await OpportunityModel.findOneAndUpdate(
    // Draf memakai judul unik sementara supaya tidak bentrok dengan lomba yang sudah ada.
    { groupId: input.groupId, title: `[draf] ${r.data.title}`.slice(0, 140) },
    { $set: { ...r.data, groupId: input.groupId, addedBy: input.addedBy, draft: true, source: 'link', sponsored: false } },
    { upsert: true, returnDocument: 'after' },
  ).lean<OpportunityDoc>();
  return { ok: true, doc: doc!, duplicate: false };
}

/** Draf disetujui → tampil untuk kelas ini. Kalau judul sudah ada, perbarui yang lama. */
export async function publishDraft(id: string, groupId: string): Promise<OpportunityDoc | null> {
  const draft = await OpportunityModel.findOne({ _id: id, groupId, draft: true }).lean<OpportunityDoc>();
  if (!draft) return null;
  const title = draft.title.replace(/^\[draf\] /, '');
  const fields: Partial<OpportunityDoc> = { ...draft };
  delete fields._id;
  const saved = await OpportunityModel.findOneAndUpdate(
    { groupId, title },
    { $set: { ...fields, title, draft: false } },
    { upsert: true, returnDocument: 'after' },
  ).lean<OpportunityDoc>();
  if (String(saved!._id) !== id) await OpportunityModel.deleteOne({ _id: id });
  return saved;
}

export const FEED_ITEMS_PER_RUN = 5;

/**
 * Baca feed RSS/Atom → halaman item baru → ekstrak → simpan sebagai info lomba global (semua kelas,
 * tetap disaring relevansi jurusan). Item yang sudah pernah dibaca dilewati.
 */
export async function importFeeds(llm: LLMProvider, reader: PageReader, feeds: string[], now: Date): Promise<{ read: number; added: string[] }> {
  const added: string[] = [];
  let read = 0;
  for (const feedUrl of feeds) {
    let items;
    try {
      items = await reader.feed(feedUrl);
    } catch (err) {
      console.warn(`[lomba] feed ${feedUrl} gagal: ${(err as Error).message}`);
      continue;
    }
    const seen = new Set((await FeedItemModel.find({ url: { $in: items.map((i) => i.link) } }, { url: 1 }).lean()).map((s) => s.url));
    const host = new URL(feedUrl).hostname.replace(/^www\./, '');
    for (const item of items.filter((i) => !seen.has(i.link)).slice(0, FEED_ITEMS_PER_RUN)) {
      read++;
      let accepted = false;
      try {
        const page = await reader.page(item.link);
        const r = await extractFromPage(llm, { ...page, text: `${item.summary}\n${page.text}`.slice(0, 12_000) }, now);
        if (r.ok && !(await OpportunityModel.exists({ link: r.data.link }))) {
          await OpportunityModel.updateOne(
            { groupId: null, title: r.data.title },
            { $set: { ...r.data, groupId: null, addedBy: `feed:${host}`, source: `feed:${host}`, draft: false, sponsored: false } },
            { upsert: true },
          );
          added.push(r.data.title);
          accepted = true;
        }
      } catch (err) {
        console.warn(`[lomba] item ${item.link} gagal: ${(err as Error).message}`);
      }
      await FeedItemModel.updateOne({ url: item.link }, { $set: { feed: feedUrl, accepted, seenAt: now } }, { upsert: true });
    }
  }
  return { read, added };
}
