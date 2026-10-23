import { GroupModel, PromiseModel, type GroupDoc, type PromiseDoc } from '../../db/models.ts';
import { doneAction, promiseCard } from '../promises/service.ts';
import { formatWIB } from '../time.ts';
import { mention, type OutgoingMessage, type Platform, type SpeechLevel } from '../types.ts';
import { nextStage, type Stage } from './escalation.ts';
import { billingText } from './templates.ts';

const STAGE_TITLE: Record<Stage, string> = {
  h2: '🔔 Pengingat janji (H-2)',
  h1: '🔔 Pengingat janji (H-1)',
  h0: '⏰ Hari ini deadline',
  overdue: '📣 Janji lewat deadline',
};

/**
 * Cek semua janji aktif dan buat pesan tagihan yang jatuh tempo.
 * Update stage memakai kondisi stage lama → aman kalau dua proses jalan bersamaan / restart.
 */
export async function collectPromiseReminders(at: Date): Promise<OutgoingMessage[]> {
  const candidates = await PromiseModel.find({
    status: 'active',
    deadline: { $ne: null, $lte: new Date(at.getTime() + 48 * 3600_000) },
    stage: { $ne: 'overdue' },
  })
    .limit(200)
    .lean<PromiseDoc[]>();
  if (!candidates.length) return [];

  const groups = await GroupModel.find({ groupId: { $in: [...new Set(candidates.map((c) => c.groupId))] } }).lean<GroupDoc[]>();
  const levelOf = new Map(groups.map((g) => [`${g.platform}:${g.groupId}`, g.speechLevel as SpeechLevel]));

  const out: OutgoingMessage[] = [];
  for (const p of candidates) {
    const stage = nextStage(p.deadline!, p.stage as Stage | 'none', at);
    if (!stage) continue;
    const set: Record<string, unknown> = { stage };
    if (stage === 'overdue') set.status = 'overdue';
    const claimed = await PromiseModel.findOneAndUpdate(
      { _id: p._id, stage: p.stage, status: 'active' },
      { $set: set },
      { returnDocument: 'after' },
    ).lean<PromiseDoc>();
    if (!claimed) continue;

    const level = levelOf.get(`${p.platform}:${p.groupId}`) ?? 'sopan';
    const text = billingText(level, stage, { nama: mention(p.owner), tugas: `**${p.task}**`, deadline: formatWIB(p.deadline!) }, `${p._id}:${stage}`);
    const card = { ...promiseCard(claimed, STAGE_TITLE[stage], stage === 'overdue' ? 'danger' : stage === 'h0' ? 'warn' : 'info') };
    const actions = [doneAction(String(p._id), level)];
    const owner = { platform: p.platform as Platform, platformUserId: p.owner.platformUserId, groupId: p.groupId, displayName: p.owner.displayName };

    // H-2/H-1/H-0 secara pribadi (tidak mempermalukan); lewat deadline baru ke grup.
    out.push(
      stage === 'overdue'
        ? { to: { kind: 'channel', channelId: p.channelId }, text, card, actions }
        : { to: { kind: 'dm', member: owner, fallbackChannelId: p.channelId }, text, card, actions },
    );
  }
  return out;
}
