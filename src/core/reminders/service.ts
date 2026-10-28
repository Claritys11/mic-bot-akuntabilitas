import { isValidObjectId } from 'mongoose';
import { GroupModel, ReminderModel, type GroupDoc, type ReminderDoc } from '../../db/models.ts';
import { PRIVATE_FALLBACK } from '../billing/templates.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { parseRelativeDate } from '../promises/dateParser.ts';
import { formatWIB, now } from '../time.ts';
import { mention, type ActionEvent, type CommandInvocation, type IncomingMessage, type Member, type OutgoingMessage, type Platform, type Reply, type SpeechLevel } from '../types.ts';
import { detectReminderOffer, looksLikeReminderRequest, parseReminderRequest, reminderTime } from './parse.ts';

// Bot sebagai teman yang bisa dititipi pengingat: "@MIC ingetin aku besok jam 7 bawa proyektor".

const MAX_ACTIVE_PER_MEMBER = 10;
const MAX_AHEAD_MS = 60 * 86400_000;
// Satu tawaran per kelas per jeda ini, supaya obrolan ramai "jangan lupa…" tidak dibanjiri tawaran.
const OFFER_COOLDOWN_MS = 5 * 60_000;

const cancelId = (id: string) => `r:no:${id}`;
const acceptId = (id: string) => `r:ok:${id}`;
const ACTIVE = { sentAt: null, cancelled: false, offered: { $ne: true } };

const CONFIRM: Record<SpeechLevel, (when: string, what: string, group: boolean) => string> = {
  santai: (when, what, group) => `siap, ${when} ku ingetin ${group ? 'semuanya' : 'kamu'}: _${what}_ ✍️`,
  sopan: (when, what, group) => `Baik, ${when} saya ingatkan ${group ? 'kelas' : 'Anda'}: _${what}_ 🙂`,
  krama: (when, what, group) => `Sendika, ${when} kula engetaken ${group ? 'sedaya kanca' : 'panjenengan'}: _${what}_ 🙏`,
};
// Jam diajukan dari hari acaranya → jelaskan, supaya "Rabu 19.00" tidak dikira jam acaranya.
const LEAD_NOTE: Record<SpeechLevel, Record<'eve' | 'morning', string>> = {
  santai: { eve: ' (malam sebelumnya, biar sempat siap-siap)', morning: ' (pagi sebelum berangkat)' },
  sopan: { eve: ' (malam sebelumnya)', morning: ' (pagi sebelum berangkat)' },
  krama: { eve: ' (dalu sakderengipun)', morning: ' (enjing sakderengipun tindak)' },
};
const whenText = (at: Date, level: SpeechLevel, lead?: 'eve' | 'morning') => formatWIB(at) + (lead ? LEAD_NOTE[level][lead] : '');
const ASK_WHEN: Record<SpeechLevel, string> = {
  santai: 'boleh, kapan ku ingetin? tulis lagi pakai waktunya ya, misal _"ingetin aku besok jam 7 bawa proyektor"_',
  sopan: 'Baik, kapan perlu saya ingatkan? Mohon tulis ulang dengan waktunya, misalnya _"ingatkan saya besok jam 7 bawa proyektor"_.',
  krama: 'Inggih, kapan kula engetaken? Mangga dipunserat malih kaliyan wekdalipun, upaminipun _"ingetin aku sesuk jam 7 bawa proyektor"_.',
};
const OFFER: Record<SpeechLevel, (when: string, what: string, group: boolean) => string> = {
  santai: (when, what, group) => `mau ku ingetin ${group ? 'semuanya' : 'kamu'} ${when}? _${what}_ 🙌`,
  sopan: (when, what, group) => `Perlu saya ingatkan ${group ? 'kelas' : 'Anda'} pada ${when}? _${what}_ 🙂`,
  krama: (when, what, group) => `Menapa kula engetaken ${group ? 'sedaya kanca' : 'panjenengan'} ${when}? _${what}_ 🙏`,
};
const OFFER_LABELS: Record<SpeechLevel, [string, string]> = {
  santai: ['⏰ Iya, ingetin', 'Nggak usah'],
  sopan: ['⏰ Ya, ingatkan', 'Tidak perlu'],
  krama: ['⏰ Inggih', 'Mboten'],
};
const DELIVER: Record<SpeechLevel, (who: string, what: string, group: boolean) => string> = {
  santai: (who, what, group) => (group ? `📢 Pengingat dari ${who} buat semuanya: **${what}**` : `⏰ ${who}, kamu minta diingetin: **${what}**`),
  sopan: (who, what, group) => (group ? `📢 Pengingat dari ${who} untuk kelas: **${what}**` : `⏰ ${who}, sesuai permintaan Anda: **${what}**`),
  krama: (who, what, group) => (group ? `📢 Pangengetan saking ${who} kangge sedaya: **${what}**` : `⏰ Nuwun sewu ${who}, panjenengan nyuwun dipunengetaken: **${what}**`),
};

async function checkLimits(groupId: string, userId: string, at: Date): Promise<string | null> {
  const active = await ReminderModel.countDocuments({ groupId, 'member.platformUserId': userId, ...ACTIVE });
  if (active >= MAX_ACTIVE_PER_MEMBER) return `Pengingatmu yang aktif sudah ${MAX_ACTIVE_PER_MEMBER}, tunggu ada yang lewat dulu ya 🙏`;
  if (at.getTime() - now().getTime() > MAX_AHEAD_MS) return 'Maksimal 60 hari ke depan ya 🙏';
  return null;
}

async function create(input: { platform: Platform; groupId: string; channelId: string; member: Member; target: 'self' | 'group'; what: string; at: Date; lead?: 'eve' | 'morning' }, level: SpeechLevel) {
  const limit = await checkLimits(input.groupId, input.member.platformUserId, input.at);
  if (limit) return { error: limit };
  const doc = await ReminderModel.create({ ...input, member: { platformUserId: input.member.platformUserId, displayName: input.member.displayName } });
  return { text: CONFIRM[level](whenText(input.at, level, input.lead), input.what, input.target === 'group'), id: String(doc._id) };
}

/** "@MIC ingetin aku …" — hanya kalau bot di-tag/dibalas atau lewat chat pribadi. null = bukan permintaan pengingat. */
export async function handleReminderRequest(msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[] | null> {
  if (!(msg.mentionsBot || msg.isDirect) || !looksLikeReminderRequest(msg.text)) return null;
  const req = parseReminderRequest(msg.text.replace(/@\S+/g, ' '), now());
  if (!req) return null;
  const level = group.speechLevel as SpeechLevel;
  const to = { kind: 'channel' as const, channelId: msg.channelId, replyTo: msg.id };
  if (!req.at) return [{ to, text: ASK_WHEN[level] }];
  // Dari chat pribadi tidak bisa mengumumkan ke grup.
  const target = msg.isDirect ? 'self' : req.target;
  const r = await create({ platform: msg.platform, groupId: msg.groupId, channelId: msg.isDirect ? (group.mainChannelId ?? msg.channelId) : msg.channelId, member: msg.author, target, what: req.what, at: req.at, lead: req.lead }, level);
  if ('error' in r) return [{ to, text: r.error! }];
  return [{ to, text: r.text, actions: [{ id: cancelId(r.id), label: 'Batal', kind: 'secondary' }] }];
}

/**
 * Obrolan biasa tanpa tag ("jangan lupa besok bawa…", "ingetin aku ya besok…") → bot menawarkan diri.
 * Pengingat baru aktif setelah pemiliknya menekan tombol; diabaikan = tidak pernah dikirim.
 */
export async function offerReminder(msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[] | null> {
  if (msg.mentionsBot || msg.isDirect || msg.replyToOther) return null;
  const req = detectReminderOffer(msg.text.replace(/@\S+/g, ' '), now());
  if (!req?.at || req.at.getTime() - now().getTime() > MAX_AHEAD_MS) return null;
  const recent = await ReminderModel.exists({ groupId: msg.groupId, offered: true, createdAt: { $gt: new Date(now().getTime() - OFFER_COOLDOWN_MS) } });
  if (recent) return null;
  const doc = await ReminderModel.create({
    platform: msg.platform,
    groupId: msg.groupId,
    channelId: msg.channelId,
    member: { platformUserId: msg.author.platformUserId, displayName: msg.author.displayName },
    target: req.target,
    what: req.what,
    at: req.at,
    lead: req.lead ?? null,
    offered: true,
  });
  const level = group.speechLevel as SpeechLevel;
  const [yes, no] = OFFER_LABELS[level];
  const id = String(doc._id);
  return [
    {
      to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id },
      text: OFFER[level](whenText(req.at, level, req.lead), req.what, req.target === 'group'),
      actions: [
        { id: acceptId(id), label: yes, kind: 'primary' },
        { id: cancelId(id), label: no, kind: 'secondary' },
      ],
    },
  ];
}

export async function ingetinCommand(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const what = String(cmd.options.apa ?? '').trim().slice(0, 200);
  const parsed = parseRelativeDate(String(cmd.options.kapan ?? ''), now());
  const when = parsed && reminderTime(parsed, now());
  if (!what) return { reply: { text: 'Isi dulu mau diingetin soal apa.', private: true } };
  if (!when) return { reply: { text: `Aku belum paham waktunya "${cmd.options.kapan}". Coba "besok jam 7" atau "jumat sore".`, private: true } };
  const target = cmd.options.untuk === 'kelas' ? 'group' : 'self';
  const r = await create({ platform: cmd.platform, groupId: cmd.groupId, channelId: cmd.channelId, member: cmd.actor, target, what, at: when.at, lead: when.lead }, group.speechLevel as SpeechLevel);
  if ('error' in r) return { reply: { text: r.error!, private: true } };
  return { reply: { text: r.text, private: target === 'self', actions: [{ id: cancelId(r.id), label: 'Batal', kind: 'secondary' }] } };
}

export async function handleReminderAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, id] = ev.actionId.split(':');
  if ((verb !== 'no' && verb !== 'ok') || !id || !isValidObjectId(id)) return { reply: { text: 'Pengingat tidak ditemukan.', private: true } };
  const r = await ReminderModel.findById(id).lean<ReminderDoc>();
  if (!r) return { reply: { text: 'Pengingat tidak ditemukan.', private: true } };
  const own = r.member.platformUserId === ev.actor.platformUserId;
  if (verb === 'ok') return acceptOffer(ev, r, own);
  if (!own && !ev.isAdmin) return { reply: { text: 'Hanya yang minta yang bisa membatalkan.', private: true } };
  if (r.offered) {
    const declined = await ReminderModel.findOneAndUpdate({ _id: id, offered: true, cancelled: false }, { $set: { cancelled: true } });
    return declined ? { update: { text: 'oke, nggak jadi 👌', actions: [] } } : { reply: { text: 'Tawaran ini sudah dijawab.', private: true } };
  }
  const done = await ReminderModel.findOneAndUpdate({ _id: id, sentAt: null, cancelled: false }, { $set: { cancelled: true } });
  return done ? { update: { text: `~~${r.what}~~ — pengingat dibatalkan 👌`, actions: [] } } : { reply: { text: 'Pengingat ini sudah lewat / dibatalkan.', private: true } };
}

async function acceptOffer(ev: ActionEvent, r: ReminderDoc, own: boolean): Promise<Reply> {
  // Pengingat pribadi hanya untuk yang menulis; pengingat kelas boleh diiyakan penulis atau admin.
  if (!own && !(r.target === 'group' && ev.isAdmin)) return { reply: { text: 'Tawaran ini untuk yang menulis pesannya 🙏', private: true } };
  if (r.at <= now()) return { update: { text: `~~${r.what}~~ — waktunya sudah lewat.`, actions: [] } };
  const limit = await checkLimits(r.groupId, r.member.platformUserId, r.at);
  if (limit) return { reply: { text: limit, private: true } };
  const ok = await ReminderModel.findOneAndUpdate({ _id: r._id, offered: true, cancelled: false }, { $set: { offered: false } });
  if (!ok) return { reply: { text: 'Tawaran ini sudah dijawab.', private: true } };
  const group = await getGroup(r.platform as Platform, r.groupId);
  const level = (group?.speechLevel ?? 'santai') as SpeechLevel;
  return { update: { text: CONFIRM[level](whenText(r.at, level, r.lead ?? undefined), r.what, r.target === 'group'), actions: [{ id: cancelId(String(r._id)), label: 'Batal', kind: 'secondary' }] } };
}

/** Scheduler: kirim pengingat yang sudah waktunya (diklaim atomik → tidak dobel). */
export async function collectReminders(at: Date): Promise<OutgoingMessage[]> {
  const due = await ReminderModel.find({ ...ACTIVE, at: { $lte: at } }).limit(100).lean<ReminderDoc[]>();
  if (!due.length) return [];
  const groups = await GroupModel.find({ groupId: { $in: [...new Set(due.map((d) => d.groupId))] } }).lean<GroupDoc[]>();
  const byId = new Map(groups.map((g) => [`${g.platform}:${g.groupId}`, g]));
  const out: OutgoingMessage[] = [];
  for (const r of due) {
    const g = byId.get(`${r.platform}:${r.groupId}`);
    if (!g || g.pilotMode === 'jeda') continue; // dijeda: tunggu sampai jeda dibuka
    const claimed = await ReminderModel.findOneAndUpdate({ _id: r._id, ...ACTIVE }, { $set: { sentAt: at } });
    if (!claimed) continue;
    const level = g.speechLevel as SpeechLevel;
    const member = { platform: r.platform as Platform, platformUserId: r.member.platformUserId, groupId: r.groupId, displayName: r.member.displayName };
    const text = DELIVER[level](mention(member), r.what, r.target === 'group');
    out.push(
      r.target === 'group'
        ? { to: { kind: 'channel', channelId: r.channelId }, text }
        : { to: { kind: 'dm', member, fallbackChannelId: r.channelId, fallbackText: PRIVATE_FALLBACK[level](mention(member)) }, text },
    );
  }
  return out;
}
