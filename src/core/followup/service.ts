import { GroupModel, OpportunityModel, PromiseModel, type GroupDoc, type PromiseDoc } from '../../db/models.ts';
import { PRIVATE_FALLBACK } from '../billing/templates.ts';
import { listMembers } from '../groups.ts';
import { paidStatus, periodKey, periodLabel, type KasPeriod } from '../kas/ledger.ts';
import { ledgerEntries } from '../kas/service.ts';
import { relevance } from '../opps/relevance.ts';
import { activeActions, confirmActions, detailLine, ids } from '../promises/service.ts';
import { LABELS } from '../promises/voice.ts';
import { formatWIB, wibParts } from '../time.ts';
import { mention, type OutgoingMessage, type Platform, type SpeechLevel } from '../types.ts';

// Bot sebagai teman yang menindaklanjuti, bukan hanya alarm:
//  • janji yang ditanya tapi belum dijawab → ditanya sekali lagi (3 jam kemudian)
//  • lewat deadline sehari → ditanya kabarnya lewat DM, ditawari ubah deadline
//  • Senin pagi → rangkuman minggu ini untuk kelas

const H = 3600_000;
export const NUDGE_AFTER_MS = 3 * H;
export const FOLLOW_UP_AFTER_MS = 25 * H; // sehari setelah pengumuman lewat deadline (+1 jam)

const NUDGE: Record<SpeechLevel, (who: string, task: string) => string> = {
  santai: (who, task) => `eh ${who}, yang tadi soal _${task}_ jadi ku catat? biar nanti ku ingetin 😄`,
  sopan: (who, task) => `${who}, yang tadi soal _${task}_ jadi dicatat? Supaya nanti bisa saya ingatkan 🙂`,
  krama: (who, task) => `Nuwun sewu ${who}, ingkang wau _${task}_ saestu dipuncathet? Supados mangke saged kula engetaken 🙏`,
};
const FOLLOW_UP: Record<SpeechLevel, (who: string, task: string) => string> = {
  santai: (who, task) => `${who}, gimana _${task}_? udah kelar belum? kalau udah klik ✅, kalau perlu mundur klik ✏️ buat atur deadline baru. butuh bantuan? bilang aja di grup 🙏`,
  sopan: (who, task) => `${who}, bagaimana kabar _${task}_? Kalau sudah selesai, klik ✅. Kalau perlu waktu tambahan, klik ✏️ untuk mengatur deadline baru 🙏`,
  krama: (who, task) => `Nuwun sewu ${who}, kados pundi _${task}_? Menawi sampun rampung mangga klik ✅, menawi betah wekdal malih mangga klik ✏️ 🙏`,
};
const DIGEST_OPEN: Record<SpeechLevel, string> = {
  santai: 'Selamat pagi! ☀️ Rangkuman minggu ini:',
  sopan: 'Selamat pagi, berikut agenda kelas minggu ini:',
  krama: 'Sugeng enjang, punika agenda kelas minggu menika:',
};

const groupKey = (platform: string, groupId: string) => `${platform}:${groupId}`;

async function activeGroups(groupIds: string[]): Promise<Map<string, GroupDoc>> {
  const groups = await GroupModel.find({ groupId: { $in: [...new Set(groupIds)] }, pilotMode: { $nin: ['diam', 'jeda'] } }).lean<GroupDoc[]>();
  return new Map(groups.map((g) => [groupKey(g.platform, g.groupId), g]));
}

/** Tanya ulang sekali untuk janji yang belum dijawab "jadi/ga jadi" (jangan biarkan yang lupa lolos). */
export async function collectNudges(at: Date): Promise<OutgoingMessage[]> {
  const rows = await PromiseModel.find({
    status: 'pending_confirm',
    nudgedAt: null,
    shadow: { $ne: true },
    askedAt: { $lte: new Date(at.getTime() - NUDGE_AFTER_MS), $gte: new Date(at.getTime() - 24 * H) },
  })
    .limit(100)
    .lean<PromiseDoc[]>();
  if (!rows.length) return [];
  const groups = await activeGroups(rows.map((r) => r.groupId));
  const out: OutgoingMessage[] = [];
  for (const p of rows) {
    const g = groups.get(groupKey(p.platform, p.groupId));
    if (!g) continue;
    const claimed = await PromiseModel.findOneAndUpdate({ _id: p._id, nudgedAt: null, status: 'pending_confirm' }, { $set: { nudgedAt: at } });
    if (!claimed) continue;
    const level = g.speechLevel as SpeechLevel;
    out.push({
      to: { kind: 'channel', channelId: p.channelId, replyTo: p.sourceMessageId ?? undefined },
      text: `${NUDGE[level](mention(p.owner), p.task)}\n${detailLine(p)}`,
      actions: confirmActions(String(p._id), level),
    });
  }
  return out;
}

/** Sehari setelah lewat deadline: tanya kabar secara pribadi + tawarkan ubah deadline. Sekali saja. */
export async function collectFollowUps(at: Date): Promise<OutgoingMessage[]> {
  const rows = await PromiseModel.find({
    status: 'overdue',
    followedUpAt: null,
    shadow: { $ne: true },
    deadline: { $lte: new Date(at.getTime() - FOLLOW_UP_AFTER_MS), $gte: new Date(at.getTime() - 14 * 24 * H) },
  })
    .limit(100)
    .lean<PromiseDoc[]>();
  if (!rows.length) return [];
  const groups = await activeGroups(rows.map((r) => r.groupId));
  const out: OutgoingMessage[] = [];
  for (const p of rows) {
    const g = groups.get(groupKey(p.platform, p.groupId));
    if (!g) continue;
    const claimed = await PromiseModel.findOneAndUpdate({ _id: p._id, followedUpAt: null, status: 'overdue' }, { $set: { followedUpAt: at } });
    if (!claimed) continue;
    const level = g.speechLevel as SpeechLevel;
    const id = String(p._id);
    const owner = { platform: p.platform as Platform, platformUserId: p.owner.platformUserId, groupId: p.groupId, displayName: p.owner.displayName };
    const notMine = p.autoActivated && !p.ownerTouched ? [{ id: ids.cancel(id), label: LABELS[level].notMine, kind: 'secondary' as const }] : [];
    out.push({
      to: { kind: 'dm', member: owner, fallbackChannelId: p.channelId, fallbackText: PRIVATE_FALLBACK[level](mention(owner)) },
      text: `${FOLLOW_UP[level](mention(owner), p.task)}\n${detailLine(p)}`,
      actions: [...activeActions(id, level), ...notMine],
    });
  }
  return out;
}

/** Senin 07.00–10.00 WIB: rangkuman minggu ini (janji, lomba, kas tanpa nama). Sekali per minggu per kelas. */
export async function collectWeeklyDigests(at: Date): Promise<OutgoingMessage[]> {
  const w = wibParts(at);
  if (w.weekday !== 1 || w.hour < 7 || w.hour >= 10) return [];
  const groups = await GroupModel.find({
    pilotMode: { $nin: ['diam', 'jeda'] },
    $or: [{ lastDigestAt: null }, { lastDigestAt: { $lte: new Date(at.getTime() - 6 * 24 * H) } }],
  }).lean<GroupDoc[]>();
  const out: OutgoingMessage[] = [];
  for (const g of groups) {
    const claimed = await GroupModel.findOneAndUpdate(
      { _id: g._id, $or: [{ lastDigestAt: null }, { lastDigestAt: { $lte: new Date(at.getTime() - 6 * 24 * H) } }] },
      { $set: { lastDigestAt: at } },
    );
    if (!claimed) continue;
    const text = await digestText(g, at);
    if (text) out.push({ to: { kind: 'channel', channelId: g.mainChannelId }, text });
  }
  return out;
}

export async function digestText(g: GroupDoc, at: Date): Promise<string | null> {
  const weekEnd = new Date(at.getTime() + 7 * 24 * H);
  const [due, overdue, opps] = await Promise.all([
    PromiseModel.find({ groupId: g.groupId, status: 'active', shadow: { $ne: true }, deadline: { $gte: at, $lte: weekEnd } }).sort({ deadline: 1 }).limit(6).lean<PromiseDoc[]>(),
    PromiseModel.countDocuments({ groupId: g.groupId, status: 'overdue', shadow: { $ne: true } }),
    OpportunityModel.find({ $or: [{ groupId: null }, { groupId: g.groupId }], deadline: { $gte: at, $lte: new Date(at.getTime() + 14 * 24 * H) } })
      .sort({ deadline: 1 })
      .limit(30)
      .lean(),
  ]);
  const lines: string[] = [];
  if (due.length) lines.push(`📌 **Deadline minggu ini (${due.length}):**\n${due.map((p) => `• ${p.task} — ${p.owner.displayName} (${formatWIB(p.deadline!)})`).join('\n')}`);
  if (overdue) lines.push(`⏳ Masih ada ${overdue} janji yang lewat deadline — yang bisa bantu, yuk dibantu 🤝`);
  const relevant = opps.filter((o) => relevance(o.tags, g.major) > 0).slice(0, 3);
  if (relevant.length) lines.push(`🏆 **Lomba yang deadline-nya dekat:**\n${relevant.map((o) => `• ${o.title} — ${formatWIB(o.deadline, 'date')}`).join('\n')}`);
  if (g.kas?.amount) {
    const members = await listMembers(g.platform as Platform, g.groupId);
    if (members.length) {
      const period = periodKey(at, (g.kas.period ?? 'bulanan') as KasPeriod);
      const { paid } = paidStatus(
        members.map((m) => ({ id: m.platformUserId, name: m.displayName })),
        await ledgerEntries(g.groupId),
        g.kas.amount,
        period,
      );
      lines.push(`💰 Kas ${periodLabel(period)}: ${paid.length} dari ${members.length} sudah lunas. Yang belum, santai aja — kirim bukti kapan pun 🙏`);
    }
  }
  if (!due.length && !overdue && !relevant.length) return null; // tidak ada yang penting → jangan ramai
  return `${DIGEST_OPEN[g.speechLevel as SpeechLevel]}\n\n${lines.join('\n\n')}`;
}
