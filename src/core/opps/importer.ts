import { z } from 'zod';
import { FeedItemModel, OpportunityModel, type OpportunityDoc } from '../../db/models.ts';
import { OPP_TAGS, opportunityImagePrompt, opportunityPrompt } from '../../llm/prompts/opportunity.ts';
import { chatJson, visionJson, type LLMProvider } from '../../llm/provider.ts';
import { formatWIB, fromWIB } from '../time.ts';
import type { FeedTarget } from './sources.ts';
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
  if (x.level && /mahasiswa|sd\/smp/i.test(x.level)) return { ok: false, reason: `untuk jenjang ${clean(x.level, 20)}, bukan SMA/SMK` };
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

/** Poster → draf info lomba (pengurus tetap harus menyimpan). `fallbackLink` = tautan ke pesan poster. */
export async function importPosterAsDraft(
  llm: LLMProvider,
  input: { image: { data: Uint8Array; mimeType: string }; groupId: string; addedBy: string; fallbackLink: string; now: Date },
): Promise<{ ok: true; doc: OpportunityDoc } | { ok: false; reason: string }> {
  if (!llm.enabled) return { ok: false, reason: 'pembaca AI belum aktif' };
  const x = await visionJson(llm, Extracted.extend({ link: z.string().nullish() }), opportunityImagePrompt(formatWIB(input.now)), input.image);
  if (!x) return { ok: false, reason: 'tulisan di gambar tidak terbaca' };
  const n = normalizeExtraction(x, input.now);
  if (!n.ok) return n;
  const link = x.link && /^https:\/\/[^\s]+$/.test(x.link) ? x.link.slice(0, 300) : input.fallbackLink;
  const tag = Math.random().toString(36).slice(2, 8);
  const created = await OpportunityModel.create({ ...n.data, link, title: `[draf ${tag}] ${n.data.title}`.slice(0, 160), groupId: input.groupId, addedBy: input.addedBy, draft: true, source: 'poster', sponsored: false });
  return { ok: true, doc: created.toObject() as OpportunityDoc };
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
  // Selalu dokumen baru (judul draf diberi penanda acak) — draf yang sedang ditinjau pengurus tidak bisa ditimpa.
  const tag = Math.random().toString(36).slice(2, 8);
  const created = await OpportunityModel.create({
    ...r.data,
    title: `[draf ${tag}] ${r.data.title}`.slice(0, 160),
    groupId: input.groupId,
    addedBy: input.addedBy,
    draft: true,
    source: 'link',
    sponsored: false,
  });
  return { ok: true, doc: created.toObject() as OpportunityDoc, duplicate: false };
}

/** Draf disetujui → tampil untuk kelas ini. Kalau judul sudah ada, perbarui yang lama. */
export async function publishDraft(id: string, groupId: string): Promise<OpportunityDoc | null> {
  const draft = await OpportunityModel.findOne({ _id: id, groupId, draft: true }).lean<OpportunityDoc>();
  if (!draft) return null;
  const title = draft.title.replace(DRAFT_PREFIX, '');
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

export const DRAFT_PREFIX = /^\[draf[^\]]*\] /;

export const FEED_ITEMS_PER_RUN = 5;

/**
 * Baca feed RSS/Atom → halaman item baru → ekstrak → simpan sebagai info lomba global (semua kelas,
 * tetap disaring relevansi jurusan). Item yang sudah pernah dibaca dilewati.
 */
let legacyIndexDropped = false;

export async function importFeeds(llm: LLMProvider, reader: PageReader, targets: FeedTarget[], now: Date): Promise<{ read: number; added: string[] }> {
  if (!legacyIndexDropped) {
    // Indeks lama (url unik global) bentrok dengan dedup per lingkup.
    await FeedItemModel.collection.dropIndex('url_1').catch(() => undefined);
    legacyIndexDropped = true;
  }
  // Sumber global dulu, baru sumber custom kelas.
  targets = [...targets].sort((a, b) => Number(a.groupId !== null) - Number(b.groupId !== null));
  const added: string[] = [];
  let read = 0;
  for (const t of targets) {
    let items;
    try {
      items = await reader.feed(t.url);
    } catch (err) {
      console.warn(`[lomba] feed ${t.url} gagal: ${(err as Error).message}`);
      continue;
    }
    const scope = t.groupId ?? 'global';
    const seen = new Set((await FeedItemModel.find({ scope, url: { $in: items.map((i) => i.link) } }, { url: 1 }).lean()).map((s) => s.url));
    const host = new URL(t.url).hostname.replace(/^www\./, '');
    for (const item of items.filter((i) => !seen.has(i.link)).slice(0, FEED_ITEMS_PER_RUN)) {
      read++;
      let accepted = false;
      try {
        const page = await reader.page(item.link);
        const r = await extractFromPage(llm, { ...page, text: `${item.summary}\n${page.text}`.slice(0, 12_000) }, now);
        // Data feed hanya MENAMBAH: lomba yang sudah ada (link/judul sama) tidak pernah ditimpa isi dari internet.
        // Cek duplikat hanya dalam lingkup yang sama — info kelas lain tidak memblokir info global / kelas ini.
        if (r.ok && !(await OpportunityModel.exists({ groupId: t.groupId, $or: [{ link: r.data.link }, { title: r.data.title }] }))) {
          const res = await OpportunityModel.updateOne(
            { link: r.data.link, groupId: t.groupId },
            { $setOnInsert: { ...r.data, groupId: t.groupId, sourceId: t.sourceId, addedBy: `feed:${host}`, source: `feed:${host}`, draft: false, sponsored: false } },
            { upsert: true },
          ).catch(() => null); // bentrok judul unik → lewati
          if (res?.upsertedCount) {
            added.push(r.data.title);
            accepted = true;
          }
        }
      } catch (err) {
        console.warn(`[lomba] item ${item.link} gagal: ${(err as Error).message}`);
      }
      await FeedItemModel.updateOne({ scope, url: item.link }, { $set: { feed: t.url, accepted, seenAt: now } }, { upsert: true });
    }
  }
  return { read, added };
}
