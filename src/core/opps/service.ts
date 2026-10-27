import { isValidObjectId } from 'mongoose';
import { GroupModel, OpportunityModel, OppPostModel, type GroupDoc, type OpportunityDoc } from '../../db/models.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { createPendingPromise } from '../promises/service.ts';
import { DAY_MS, formatWIB, now, wibParts } from '../time.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import { mention, sanitize, type Action, type ActionEvent, type Card, type CommandInvocation, type IncomingMessage, type OutgoingMessage, type Reply } from '../types.ts';
import { DRAFT_PREFIX, importFeeds, importLinkAsDraft, importPosterAsDraft, publishDraft, type PageReader } from './importer.ts';
import { inQuietHours } from '../quiet.ts';
import { audit } from '../team/audit.ts';
import { can } from '../team/roles.ts';
import { pickNextOpportunity, relevance } from './relevance.ts';
import { customSourceId, feedTargets, isEnabled, MAX_CUSTOM_SOURCES, visibleTo, type LombaSource } from './sources.ts';
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
      : `${auto ? `Dibaca otomatis dari ${new URL(o.link).hostname.replace(/^www\./, '')} — cek ulang di link resmi.` : ''}${o.kind === 'beasiswa' ? '' : ' Klik "Bentuk tim" untuk membuat thread & janji awal.'}`.trim();
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
  const inOpps = msg.channelId === group.oppsChannelId;
  const poster = msg.attachments.find((a) => (a.contentType ?? '').startsWith('image/') && (a.size ?? 0) <= 10 * 1024 * 1024);
  const url = msg.text.match(LINK_RE)?.[0]?.replace(/[).,!?]+$/, '');
  // Poster / screenshot di #info-lomba, atau dikirim sambil tag aku + kata "lomba".
  const wantsPoster = poster && !url && (inOpps || (msg.mentionsBot && OPP_WORDS.test(msg.text)));
  if (!wantsPoster && (!reader || !url || !OPP_WORDS.test(msg.text) || (!msg.mentionsBot && !inOpps))) return null;
  const to = { kind: 'channel' as const, channelId: msg.channelId, replyTo: msg.id };
  const t = Date.now();
  const recent = (recentImports.get(group.groupId) ?? []).filter((x) => t - x < 3600_000);
  if (recent.length >= LINK_IMPORTS_PER_HOUR) return [{ to, text: 'Aku udah baca banyak info sejam ini 😅 coba lagi nanti ya, atau pengurus bisa pakai `/lomba tambah`.' }];
  recentImports.set(group.groupId, [...recent, t]);
  if (wantsPoster) {
    const p = await importPosterAsDraft(llm, {
      image: { data: await poster.getData(), mimeType: poster.contentType ?? 'image/jpeg' },
      groupId: group.groupId,
      addedBy: msg.author.platformUserId,
      fallbackLink: msg.platform === 'discord' ? `https://discord.com/channels/${msg.groupId}/${msg.channelId}/${msg.id}` : 'poster di grup',
      now: now(),
    });
    if (!p.ok) return inOpps && !msg.mentionsBot ? null : [{ to, text: `Makasih posternya 🙏 tapi aku belum bisa ambil datanya: ${p.reason}.` }];
    return [{ to, text: `Makasih ${mention(msg.author)}! Ini yang kebaca dari posternya 👇 Pengurus, cek dulu lalu simpan ya.`, card: oppCard(p.doc), actions: draftActions(String(p.doc._id)) }];
  }
  if (!reader || !url) return null;
  const r = await importLinkAsDraft(llm, reader, { url, groupId: group.groupId, addedBy: msg.author.platformUserId, now: now() });
  if (!r.ok) return [{ to, text: `Makasih infonya 🙏 tapi aku belum bisa ambil datanya: ${r.reason}. Pengurus bisa tambah manual pakai \`/lomba tambah\`.` }];
  if (r.duplicate) {
    const word = r.doc.kind === 'beasiswa' ? 'Beasiswa' : 'Lomba';
    const team = r.doc.kind === 'beasiswa' ? [] : [{ id: teamId(String(r.doc._id)), label: '👥 Bentuk tim', kind: 'primary' as const }];
    return [{ to, text: `${word} ini sudah ada di catatanku 👍`, card: oppCard(r.doc), actions: team }];
  }
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
    if (inQuietHours(at, g.quietHours)) continue;
    const visible = opps.filter((o) => visibleTo(g, o));
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

export async function handleOppAction(ev: ActionEvent, sources: LombaSource[] = []): Promise<Reply> {
  const [, verb, id] = ev.actionId.split(':');
  if ((verb === 'src' || verb === 'srcdel') && id) return handleSourceAction(ev, verb, id, sources);
  if (!id || !isValidObjectId(id)) return { reply: { text: 'Info lomba tidak ditemukan.', private: true } };
  const o = await OpportunityModel.findById(id).lean<OpportunityDoc>();
  if (!o || (o.groupId != null && o.groupId !== ev.groupId)) return { reply: { text: 'Info lomba tidak ditemukan.', private: true } };

  if (verb === 'save' || verb === 'drop') {
    if (!can(await getGroup(ev.platform, ev.groupId), ev, 'lomba')) return { reply: { text: 'Yang bisa menyimpan/membuang info lomba: ketua, sekretaris, atau admin 🙏', private: true } };
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
  if (!can(await getGroup(cmd.platform, cmd.groupId), cmd, 'lomba')) return { reply: { text: 'Yang bisa menambah info lomba: ketua, sekretaris, atau admin. Siswa bisa kirim linknya sambil tag aku 😉', private: true } };
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
  const opps = (await OpportunityModel.find({ deadline: { $gt: at }, groupId: { $in: [null, cmd.groupId] }, draft: { $ne: true } }).lean<OpportunityDoc[]>()).filter((o) =>
    visibleTo(group, o),
  );
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

// ---------- Sumber info lomba per kelas ----------

const recentFetch = new Map<string, number>();

function sourcesCard(g: GroupDoc, all: LombaSource[]): { card: Card; actions: Action[] } {
  const custom = g.lombaSources?.custom ?? [];
  const lines = all.map((s) => `${isEnabled(g, s.id) ? '✅' : '⬜'} **${s.name}** — ${s.desc}`);
  for (const c of custom) lines.push(`🔗 **${c.name}** (khusus kelas ini) — ${c.url}`);
  const actions: Action[] = [
    ...all.map((s) => ({ id: `o:src:${s.id}`, label: `${isEnabled(g, s.id) ? 'Matikan' : 'Nyalakan'} ${s.name}`, kind: isEnabled(g, s.id) ? ('secondary' as const) : ('success' as const) })),
    ...custom.map((c) => ({ id: `o:srcdel:${c.id}`, label: `🗑️ ${c.name}`.slice(0, 80), kind: 'danger' as const })),
  ];
  return {
    card: {
      title: '📡 Sumber info lomba kelas ini',
      tone: 'info',
      description: lines.join('\n'),
      footer: `Aku ambil info baru ±sehari sekali, saring yang cocok untuk ${g.major}, lalu bagikan maks 2/minggu. Tambah sumber: /lomba sumber-tambah link:… · ambil sekarang: /lomba ambil`,
    },
    actions: actions.slice(0, 20),
  };
}

export async function lombaSumber(cmd: CommandInvocation, all: LombaSource[]): Promise<Reply> {
  const g = await getGroup(cmd.platform, cmd.groupId);
  if (!g) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const { card, actions } = sourcesCard(g, all);
  return { reply: { card, actions: can(g, cmd, 'lomba') ? actions : [], private: true } };
}

/** Sumber custom: harus feed RSS/Atom yang terbaca (lewat pengambil halaman aman). Isinya hanya untuk kelas ini. */
export async function lombaSumberTambah(cmd: CommandInvocation, reader: PageReader | undefined): Promise<Reply> {
  const g = await getGroup(cmd.platform, cmd.groupId);
  if (!g) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!can(g, cmd, 'lomba')) return { reply: { text: 'Yang bisa menambah sumber: ketua, sekretaris, atau admin.', private: true } };
  if (!reader) return { reply: { text: 'Pengambil halaman web belum aktif di bot ini.', private: true } };
  const url = String(cmd.options.link ?? '').trim();
  if (!isHttpsUrl(url)) return { reply: { text: 'Link harus https://…', private: true } };
  const custom = g.lombaSources?.custom ?? [];
  if (custom.length >= MAX_CUSTOM_SOURCES) return { reply: { text: `Maksimal ${MAX_CUSTOM_SOURCES} sumber tambahan. Hapus salah satu dulu di /lomba sumber.`, private: true } };
  const id = customSourceId(url);
  if (custom.some((c) => c.id === id)) return { reply: { text: 'Sumber ini sudah ada.', private: true } };
  let items;
  try {
    items = await reader.feed(url);
  } catch (err) {
    return { reply: { text: `Belum bisa dibaca: ${(err as Error).message}.`, private: true } };
  }
  if (!items.length) {
    return { reply: { text: 'Link itu bukan feed RSS/Atom yang berisi info. Coba alamat feed-nya (biasanya …/feed atau …/rss). Untuk satu lomba saja, kirim linknya sambil tag aku.', private: true } };
  }
  const name = String(cmd.options.nama ?? '').trim().slice(0, 40) || new URL(url).hostname.replace(/^www\./, '');
  await GroupModel.updateOne({ _id: g._id }, { $push: { 'lombaSources.custom': { id, name: sanitize(name), url, addedBy: cmd.actor.platformUserId } } });
  await audit(cmd.groupId, cmd.actor, 'lomba.sumber', `tambah ${name}`);
  return { reply: { text: `✅ Sumber **${sanitize(name)}** ditambahkan (${items.length} item terbaca). Info dari sini hanya untuk kelas ini. Ambil sekarang: /lomba ambil`, private: true } };
}

/** /lomba ambil — baca sumber kelas ini sekarang juga (maks sekali per 30 menit). */
export async function lombaAmbil(cmd: CommandInvocation, llm: LLMProvider, reader: PageReader | undefined, all: LombaSource[]): Promise<Reply> {
  const g = await getGroup(cmd.platform, cmd.groupId);
  if (!g) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!can(g, cmd, 'lomba')) return { reply: { text: 'Yang bisa mengambil info sekarang: ketua, sekretaris, atau admin.', private: true } };
  if (!reader || !llm.enabled) return { reply: { text: 'Pengambil info lomba belum aktif di bot ini.', private: true } };
  const last = recentFetch.get(g.groupId) ?? 0;
  if (Date.now() - last < 30 * 60_000) return { reply: { text: 'Baru saja diambil — coba lagi 30 menit lagi ya.', private: true } };
  recentFetch.set(g.groupId, Date.now());
  const targets = (await feedTargets(all, g.groupId)).filter((t) => t.groupId === g.groupId || isEnabled(g, t.sourceId));
  const r = await importFeeds(llm, reader, targets, now());
  const fresh = r.added.length ? `\n${r.added.map((t) => `• ${t}`).join('\n')}` : '';
  return {
    reply: {
      text: `📡 ${r.read} info baru dibaca dari ${targets.length} sumber, ${r.added.length} lomba/beasiswa yang masih buka & cocok untuk SMA/SMK tersimpan.${fresh}\nLihat: /lomba list`,
      private: true,
    },
  };
}

export async function handleSourceAction(ev: ActionEvent, verb: string, id: string, all: LombaSource[]): Promise<Reply> {
  const g = await getGroup(ev.platform, ev.groupId);
  if (!g || !can(g, ev, 'lomba')) return { reply: { text: 'Yang bisa mengatur sumber: ketua, sekretaris, atau admin.', private: true } };
  if (verb === 'src' && all.some((s) => s.id === id)) {
    await GroupModel.updateOne({ _id: g._id }, isEnabled(g, id) ? { $addToSet: { 'lombaSources.disabled': id } } : { $pull: { 'lombaSources.disabled': id } });
  } else if (verb === 'srcdel') {
    await GroupModel.updateOne({ _id: g._id }, { $pull: { 'lombaSources.custom': { id } } });
    await audit(ev.groupId, ev.actor, 'lomba.sumber', `hapus ${id}`);
  } else return { reply: { text: 'Sumber tidak dikenal.', private: true } };
  const fresh = (await getGroup(ev.platform, ev.groupId))!;
  const { card, actions } = sourcesCard(fresh, all);
  return { update: { card, actions } };
}
