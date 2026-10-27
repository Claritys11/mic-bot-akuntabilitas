import { isValidObjectId } from 'mongoose';
import { GroupModel, OpportunityModel, OppPostModel, type GroupDoc, type OpportunityDoc } from '../../db/models.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { createPendingPromise } from '../promises/service.ts';
import { DAY_MS, formatWIB, now, wibParts } from '../time.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import { mention, type Action, type ActionEvent, type Card, type CommandInvocation, type IncomingMessage, type OutgoingMessage, type Reply } from '../types.ts';
import { DRAFT_PREFIX, importLinkAsDraft, publishDraft, type PageReader } from './importer.ts';
import { pickNextOpportunity, relevance } from './relevance.ts';
import { SEED_OPPORTUNITIES } from './seed.ts';

const MAX_POSTS_PER_WEEK = 2;

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}
const teamId = (id: string) => `o:team:${id}`;
const draftActions = (id: string): Action[] => [
  { id: `o:save:${id}`, label: '💾 Simpan untuk kelas', kind: 'success' },
  { id: `o:drop:${id}`, label: '🗑️ Buang', kind: 'secondary' },
];

export async function seedOpportunities(at: Date): Promise<number> {
  if (await OpportunityModel.estimatedDocumentCount()) return 0;
  await OpportunityModel.insertMany(
    SEED_OPPORTUNITIES.map((s) => ({
      title: s.title,
      organizer: s.organizer,
      deadline: new Date(at.getTime() + s.daysFromNow * DAY_MS),
      tags: s.tags,
      link: s.link,
      description: `${s.description}\n_Tanggal perkiraan — cek situs resmi._`,
      addedBy: 'seed',
    })),
  );
  return SEED_OPPORTUNITIES.length;
}

function oppCard(o: OpportunityDoc): Card {
  const auto = o.source?.startsWith('feed:') || o.source === 'link';
  const footer = o.draft
    ? 'Draf hasil baca otomatis — cek dulu, lalu pengurus klik "Simpan" supaya tampil untuk kelas.'
    : o.sponsored
      ? 'Promosi — konten berbayar dari penyelenggara.'
      : `${auto ? `Dibaca otomatis dari ${new URL(o.link).hostname.replace(/^www\./, '')} — cek ulang di link resmi. ` : ''}Klik "Bentuk tim" untuk membuat thread & janji awal.`;
  return {
    title: `${o.sponsored ? '[Promosi] ' : ''}${o.kind === 'beasiswa' ? '🎓' : '🏆'} ${o.title.replace(DRAFT_PREFIX, '')}`,
    tone: o.draft ? 'warn' : o.sponsored ? 'warn' : 'info',
    description: o.description || undefined,
    fields: [
      { name: 'Penyelenggara', value: o.organizer, inline: true },
      { name: 'Deadline', value: formatWIB(o.deadline, 'date'), inline: true },
      { name: 'Tag', value: o.tags.join(', ') || '—', inline: true },
      ...(o.fee ? [{ name: 'Biaya', value: o.fee, inline: true }] : []),
      { name: 'Info', value: o.link },
    ],
    footer,
  };
}

const LINK_RE = /https:\/\/[^\s<>"']+/i;
const OPP_WORDS = /\b(lomba|kompetisi|olimpiade|olim|hackathon|beasiswa|lks|challenge|competition|ctf|festival|sayembara)\b/i;
/** Maks baca link per kelas per jam (cegah spam & biaya). */
const LINK_IMPORTS_PER_HOUR = 5;
const recentImports = new Map<string, number[]>();

/** "@MIC ada lomba nih https://…" atau link lomba di channel info lomba → draf untuk disetujui pengurus. */
export async function handleOppLink(llm: LLMProvider, reader: PageReader | undefined, msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[] | null> {
  if (!reader) return null;
  const url = msg.text.match(LINK_RE)?.[0]?.replace(/[).,!?]+$/, '');
  if (!url || !OPP_WORDS.test(msg.text)) return null;
  if (!msg.mentionsBot && msg.channelId !== group.oppsChannelId) return null;
  const to = { kind: 'channel' as const, channelId: msg.channelId, replyTo: msg.id };
  const t = Date.now();
  const recent = (recentImports.get(group.groupId) ?? []).filter((x) => t - x < 3600_000);
  if (recent.length >= LINK_IMPORTS_PER_HOUR) return [{ to, text: 'Aku udah baca banyak link sejam ini 😅 coba lagi nanti ya, atau pengurus bisa pakai `/lomba tambah`.' }];
  recentImports.set(group.groupId, [...recent, t]);
  const r = await importLinkAsDraft(llm, reader, { url, groupId: group.groupId, addedBy: msg.author.platformUserId, now: now() });
  if (!r.ok) return [{ to, text: `Makasih infonya 🙏 tapi aku belum bisa ambil datanya: ${r.reason}. Pengurus bisa tambah manual pakai \`/lomba tambah\`.` }];
  if (r.duplicate) return [{ to, text: `Lomba ini sudah ada di catatanku 👍`, card: oppCard(r.doc) }];
  return [{ to, text: `Makasih ${mention(msg.author)}! Ini yang kebaca dari linknya 👇 Pengurus, cek dulu lalu simpan ya.`, card: oppCard(r.doc), actions: draftActions(String(r.doc._id)) }];
}

/** Posting maks 2 info lomba relevan per minggu ke channel info lomba tiap kelas. */
export async function collectOppPosts(at: Date): Promise<OutgoingMessage[]> {
  const hour = wibParts(at).hour;
  if (hour < 7 || hour >= 20) return []; // jangan posting malam hari
  const groups = await GroupModel.find({ oppsChannelId: { $ne: null }, pilotMode: { $nin: ['diam', 'jeda'] } }).lean<GroupDoc[]>();
  if (!groups.length) return [];
  const opps = await OpportunityModel.find({ deadline: { $gt: at }, draft: { $ne: true } }).lean<OpportunityDoc[]>();
  const out: OutgoingMessage[] = [];
  for (const g of groups) {
    const visible = opps.filter((o) => o.groupId == null || o.groupId === g.groupId);
    const posts = await OppPostModel.find({ groupId: g.groupId }).lean();
    const recent = posts.filter((p) => p.postedAt.getTime() > at.getTime() - 7 * DAY_MS).length;
    if (recent >= MAX_POSTS_PER_WEEK) continue;
    const pick = pickNextOpportunity(
      visible.map((o) => ({ ...o, id: String(o._id) })),
      g.major,
      new Set(posts.map((p) => String(p.opportunityId))),
      at,
    );
    if (!pick) continue;
    try {
      await OppPostModel.create({ groupId: g.groupId, opportunityId: pick._id, postedAt: at });
    } catch {
      continue;
    }
    out.push({
      to: { kind: 'channel', channelId: g.oppsChannelId! },
      text: `Info lomba yang cocok untuk ${g.major} 👇`,
      card: oppCard(pick),
      actions: [{ id: teamId(String(pick._id)), label: '👥 Bentuk tim', kind: 'primary' }],
    });
  }
  return out;
}

export async function handleOppAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, id] = ev.actionId.split(':');
  if (!id || !isValidObjectId(id)) return { reply: { text: 'Info lomba tidak ditemukan.', private: true } };
  const o = await OpportunityModel.findById(id).lean<OpportunityDoc>();
  if (!o || (o.groupId != null && o.groupId !== ev.groupId)) return { reply: { text: 'Info lomba tidak ditemukan.', private: true } };

  if (verb === 'save' || verb === 'drop') {
    if (!ev.isAdmin) return { reply: { text: 'Yang bisa menyimpan/membuang info lomba hanya pengurus kelas 🙏', private: true } };
    if (!o.draft) return { reply: { text: 'Info ini sudah diproses.', private: true } };
    if (verb === 'drop') {
      await OpportunityModel.deleteOne({ _id: id, draft: true });
      return { update: { text: '🗑️ Draf dibuang.', card: undefined, actions: [] } };
    }
    const saved = await publishDraft(id, ev.groupId);
    if (!saved) return { reply: { text: 'Draf tidak ditemukan.', private: true } };
    return { update: { text: `✅ Disimpan oleh ${mention(ev.actor)} — tampil di \`/lomba list\` & bisa diposting ke kelas.`, card: oppCard(saved), actions: [{ id: teamId(String(saved._id)), label: '👥 Bentuk tim', kind: 'primary' }] } };
  }
  if (o.draft) return { reply: { text: 'Info ini masih draf — tunggu disimpan pengurus dulu ya.', private: true } };

  const at = now();
  const lead = o.deadline.getTime() - at.getTime() > 5 * DAY_MS ? 3 * DAY_MS : DAY_MS;
  const deadline = new Date(Math.max(o.deadline.getTime() - lead, at.getTime() + 3600_000));
  const promise = await createPendingPromise({ ctx: ev, owner: ev.actor, task: `Daftar ${o.title}`, deadline, source: 'opportunity' });
  const thread = { kind: 'thread' as const, channelId: ev.channelId, anchorMessageId: ev.messageId, name: `Tim ${o.title}`.slice(0, 90) };
  return {
    reply: { text: 'Thread tim dibuat 👍', private: true },
    messages: [
      { to: thread, text: `👥 ${mention(ev.actor)} membuka tim untuk **${o.title}**. Yang mau gabung, balas di thread ini ya!` },
      { to: thread, text: `${mention(ev.actor)}, sebagai langkah pertama:`, card: promise.card, actions: promise.actions },
    ],
  };
}

export async function lombaTambah(cmd: CommandInvocation, llm?: LLMProvider, reader?: PageReader): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Hanya admin yang bisa menambah info lomba. Siswa bisa kirim linknya sambil tag aku 😉', private: true } };
  const title = String(cmd.options.judul ?? '').trim();
  const deadlineRaw = String(cmd.options.deadline ?? '').trim();
  // Cukup link → bot membaca halamannya, pengurus tinggal cek & simpan.
  if (!title && !deadlineRaw && llm && reader) {
    const url = String(cmd.options.link ?? '').trim();
    if (!isHttpsUrl(url)) return { reply: { text: 'Link harus URL https://', private: true } };
    const r = await importLinkAsDraft(llm, reader, { url, groupId: cmd.groupId, addedBy: cmd.actor.platformUserId, now: now() });
    if (!r.ok) return { reply: { text: `Aku belum bisa ambil datanya: ${r.reason}. Isi manual: \`/lomba tambah link:… judul:… deadline:YYYY-MM-DD\`.`, private: true } };
    if (r.duplicate) return { reply: { text: 'Lomba ini sudah ada 👍', card: oppCard(r.doc), private: true } };
    return { reply: { text: 'Ini yang kebaca 👇 cek dulu, lalu simpan.', card: oppCard(r.doc), actions: draftActions(String(r.doc._id)), private: true } };
  }
  const m = deadlineRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!title || !m) return { reply: { text: 'Judul wajib & deadline format YYYY-MM-DD.', private: true } };
  const link = String(cmd.options.link ?? '').trim();
  if (!isHttpsUrl(link)) return { reply: { text: 'Link harus URL https://', private: true } };
  const deadline = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 16, 59)); // 23:59 WIB
  const tags = String(cmd.options.tag ?? 'umum').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  // Selalu terikat ke server ini: admin satu server tidak bisa menimpa/menyiarkan ke server lain.
  const doc = await OpportunityModel.findOneAndUpdate(
    { title, groupId: cmd.groupId },
    {
      $set: {
        title,
        organizer: String(cmd.options.penyelenggara ?? '-'),
        deadline,
        tags,
        link,
        groupId: cmd.groupId,
        description: String(cmd.options.deskripsi ?? ''),
        sponsored: cmd.options.promosi === true,
        addedBy: cmd.actor.platformUserId,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean<OpportunityDoc>();
  return { reply: { text: 'Info lomba disimpan ✅', card: oppCard(doc!), private: true } };
}

export async function lombaList(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const at = now();
  const opps = await OpportunityModel.find({ deadline: { $gt: at }, groupId: { $in: [null, cmd.groupId] }, draft: { $ne: true } }).lean<OpportunityDoc[]>();
  // Yang ditambahkan kelas ini sendiri selalu tampil (dan paling atas), sisanya disaring relevansi jurusan.
  const ranked = opps
    .map((o) => ({ o, s: relevance(o.tags, group.major) + (o.groupId === cmd.groupId ? 100 : 0) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || a.o.deadline.getTime() - b.o.deadline.getTime())
    .slice(0, 8);
  if (!ranked.length) return { reply: { text: 'Belum ada info lomba yang cocok.', private: true } };
  return {
    reply: {
      private: true,
      card: {
        title: `🏆 Lomba yang cocok untuk ${group.major}`,
        tone: 'info',
        footer: 'Punya info lomba? Kirim linknya sambil tag aku, nanti aku bacakan 😉',
        description: ranked
          .map(({ o }) => `• ${o.sponsored ? '**[Promosi]** ' : ''}${o.kind === 'beasiswa' ? '🎓 ' : ''}**${o.title}** — ${o.organizer} · ${formatWIB(o.deadline, 'date')}\n  ${o.link}`)
          .join('\n'),
      },
    },
  };
}
