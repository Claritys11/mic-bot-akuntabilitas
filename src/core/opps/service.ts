import { isValidObjectId } from 'mongoose';
import { GroupModel, OpportunityModel, OppPostModel, type GroupDoc, type OpportunityDoc } from '../../db/models.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { createPendingPromise } from '../promises/service.ts';
import { DAY_MS, formatWIB, now, wibParts } from '../time.ts';
import { mention, type ActionEvent, type Card, type CommandInvocation, type OutgoingMessage, type Reply } from '../types.ts';
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
  return {
    title: `${o.sponsored ? '[Promosi] ' : ''}🏆 ${o.title}`,
    tone: o.sponsored ? 'warn' : 'info',
    description: o.description || undefined,
    fields: [
      { name: 'Penyelenggara', value: o.organizer, inline: true },
      { name: 'Deadline', value: formatWIB(o.deadline, 'date'), inline: true },
      { name: 'Tag', value: o.tags.join(', ') || '—', inline: true },
      { name: 'Info', value: o.link },
    ],
    footer: o.sponsored ? 'Promosi — konten berbayar dari penyelenggara.' : 'Klik "Bentuk tim" untuk membuat thread & janji awal.',
  };
}

/** Posting maks 2 info lomba relevan per minggu ke channel info lomba tiap kelas. */
export async function collectOppPosts(at: Date): Promise<OutgoingMessage[]> {
  const hour = wibParts(at).hour;
  if (hour < 7 || hour >= 20) return []; // jangan posting malam hari
  const groups = await GroupModel.find({ oppsChannelId: { $ne: null }, pilotMode: { $nin: ['diam', 'jeda'] } }).lean<GroupDoc[]>();
  if (!groups.length) return [];
  const opps = await OpportunityModel.find({ deadline: { $gt: at } }).lean<OpportunityDoc[]>();
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
  const id = ev.actionId.split(':')[2];
  if (!id || !isValidObjectId(id)) return { reply: { text: 'Info lomba tidak ditemukan.', private: true } };
  const o = await OpportunityModel.findById(id).lean<OpportunityDoc>();
  if (!o || (o.groupId != null && o.groupId !== ev.groupId)) return { reply: { text: 'Info lomba tidak ditemukan.', private: true } };

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

export async function lombaTambah(cmd: CommandInvocation): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Hanya admin yang bisa menambah info lomba.', private: true } };
  const title = String(cmd.options.judul ?? '').trim();
  const deadlineRaw = String(cmd.options.deadline ?? '').trim();
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
  const opps = await OpportunityModel.find({ deadline: { $gt: at }, groupId: { $in: [null, cmd.groupId] } }).lean<OpportunityDoc[]>();
  const ranked = opps
    .map((o) => ({ o, s: relevance(o.tags, group.major) }))
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
        description: ranked
          .map(({ o }) => `• ${o.sponsored ? '**[Promosi]** ' : ''}**${o.title}** — ${o.organizer} · ${formatWIB(o.deadline, 'date')}\n  ${o.link}`)
          .join('\n'),
      },
    },
  };
}
