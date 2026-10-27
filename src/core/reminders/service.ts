import { isValidObjectId } from 'mongoose';
import { GroupModel, ReminderModel, type GroupDoc, type ReminderDoc } from '../../db/models.ts';
import { PRIVATE_FALLBACK } from '../billing/templates.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { parseRelativeDate } from '../promises/dateParser.ts';
import { formatWIB, now } from '../time.ts';
import { mention, type ActionEvent, type CommandInvocation, type IncomingMessage, type Member, type OutgoingMessage, type Platform, type Reply, type SpeechLevel } from '../types.ts';
import { looksLikeReminderRequest, parseReminderRequest } from './parse.ts';

// Bot sebagai teman yang bisa dititipi pengingat: "@MIC ingetin aku besok jam 7 bawa proyektor".

const MAX_ACTIVE_PER_MEMBER = 10;
const MAX_AHEAD_MS = 60 * 86400_000;

const cancelId = (id: string) => `r:no:${id}`;

const CONFIRM: Record<SpeechLevel, (when: string, what: string, group: boolean) => string> = {
  santai: (when, what, group) => `siap, ${when} ku ingetin ${group ? 'semuanya' : 'kamu'}: _${what}_ ✍️`,
  sopan: (when, what, group) => `Baik, ${when} saya ingatkan ${group ? 'kelas' : 'Anda'}: _${what}_ 🙂`,
  krama: (when, what, group) => `Sendika, ${when} kula engetaken ${group ? 'sedaya kanca' : 'panjenengan'}: _${what}_ 🙏`,
};
const ASK_WHEN: Record<SpeechLevel, string> = {
  santai: 'boleh, kapan ku ingetin? tulis lagi pakai waktunya ya, misal _"ingetin aku besok jam 7 bawa proyektor"_',
  sopan: 'Baik, kapan perlu saya ingatkan? Mohon tulis ulang dengan waktunya, misalnya _"ingatkan saya besok jam 7 bawa proyektor"_.',
  krama: 'Inggih, kapan kula engetaken? Mangga dipunserat malih kaliyan wekdalipun, upaminipun _"ingetin aku sesuk jam 7 bawa proyektor"_.',
};
const DELIVER: Record<SpeechLevel, (who: string, what: string, group: boolean) => string> = {
  santai: (who, what, group) => (group ? `📢 Pengingat dari ${who} buat semuanya: **${what}**` : `⏰ ${who}, kamu minta diingetin: **${what}**`),
  sopan: (who, what, group) => (group ? `📢 Pengingat dari ${who} untuk kelas: **${what}**` : `⏰ ${who}, sesuai permintaan Anda: **${what}**`),
  krama: (who, what, group) => (group ? `📢 Pangengetan saking ${who} kangge sedaya: **${what}**` : `⏰ Nuwun sewu ${who}, panjenengan nyuwun dipunengetaken: **${what}**`),
};

async function create(input: { platform: Platform; groupId: string; channelId: string; member: Member; target: 'self' | 'group'; what: string; at: Date }, level: SpeechLevel) {
  const active = await ReminderModel.countDocuments({ groupId: input.groupId, 'member.platformUserId': input.member.platformUserId, sentAt: null, cancelled: false });
  if (active >= MAX_ACTIVE_PER_MEMBER) return { error: `Pengingatmu yang aktif sudah ${MAX_ACTIVE_PER_MEMBER}, tunggu ada yang lewat dulu ya 🙏` };
  if (input.at.getTime() - now().getTime() > MAX_AHEAD_MS) return { error: 'Maksimal 60 hari ke depan ya 🙏' };
  const doc = await ReminderModel.create({ ...input, member: { platformUserId: input.member.platformUserId, displayName: input.member.displayName } });
  return { text: CONFIRM[level](formatWIB(input.at), input.what, input.target === 'group'), id: String(doc._id) };
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
  const r = await create({ platform: msg.platform, groupId: msg.groupId, channelId: msg.isDirect ? (group.mainChannelId ?? msg.channelId) : msg.channelId, member: msg.author, target, what: req.what, at: req.at }, level);
  if ('error' in r) return [{ to, text: r.error! }];
  return [{ to, text: r.text, actions: [{ id: cancelId(r.id), label: 'Batal', kind: 'secondary' }] }];
}

export async function ingetinCommand(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const what = String(cmd.options.apa ?? '').trim().slice(0, 200);
  const parsed = parseRelativeDate(String(cmd.options.kapan ?? ''), now());
  if (!what) return { reply: { text: 'Isi dulu mau diingetin soal apa.', private: true } };
  if (!parsed || parsed.date <= now()) return { reply: { text: `Aku belum paham waktunya "${cmd.options.kapan}". Coba "besok jam 7" atau "jumat sore".`, private: true } };
  const target = cmd.options.untuk === 'kelas' ? 'group' : 'self';
  const r = await create({ platform: cmd.platform, groupId: cmd.groupId, channelId: cmd.channelId, member: cmd.actor, target, what, at: parsed.date }, group.speechLevel as SpeechLevel);
  if ('error' in r) return { reply: { text: r.error!, private: true } };
  return { reply: { text: r.text, private: target === 'self', actions: [{ id: cancelId(r.id), label: 'Batal', kind: 'secondary' }] } };
}

export async function handleReminderAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, id] = ev.actionId.split(':');
  if (verb !== 'no' || !id || !isValidObjectId(id)) return { reply: { text: 'Pengingat tidak ditemukan.', private: true } };
  const r = await ReminderModel.findById(id).lean<ReminderDoc>();
  if (!r) return { reply: { text: 'Pengingat tidak ditemukan.', private: true } };
  if (r.member.platformUserId !== ev.actor.platformUserId && !ev.isAdmin) return { reply: { text: 'Hanya yang minta yang bisa membatalkan.', private: true } };
  const done = await ReminderModel.findOneAndUpdate({ _id: id, sentAt: null, cancelled: false }, { $set: { cancelled: true } });
  return done ? { update: { text: `~~${r.what}~~ — pengingat dibatalkan 👌`, actions: [] } } : { reply: { text: 'Pengingat ini sudah lewat / dibatalkan.', private: true } };
}

/** Scheduler: kirim pengingat yang sudah waktunya (diklaim atomik → tidak dobel). */
export async function collectReminders(at: Date): Promise<OutgoingMessage[]> {
  const due = await ReminderModel.find({ sentAt: null, cancelled: false, at: { $lte: at } }).limit(100).lean<ReminderDoc[]>();
  if (!due.length) return [];
  const groups = await GroupModel.find({ groupId: { $in: [...new Set(due.map((d) => d.groupId))] } }).lean<GroupDoc[]>();
  const byId = new Map(groups.map((g) => [`${g.platform}:${g.groupId}`, g]));
  const out: OutgoingMessage[] = [];
  for (const r of due) {
    const g = byId.get(`${r.platform}:${r.groupId}`);
    if (!g || g.pilotMode === 'jeda') continue; // dijeda: tunggu sampai jeda dibuka
    const claimed = await ReminderModel.findOneAndUpdate({ _id: r._id, sentAt: null, cancelled: false }, { $set: { sentAt: at } });
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
