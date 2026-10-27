import { AuditModel, MemberModel } from '../../db/models.ts';
import { now } from '../time.ts';

/** Catat tindakan penting. Gagal mencatat tidak boleh menggagalkan tindakannya. */
export async function audit(groupId: string, actor: { platformUserId: string; displayName: string }, action: string, detail = '', subjectId: string | null = null): Promise<void> {
  await AuditModel.create({ groupId, at: now(), actorId: actor.platformUserId, actorName: actor.displayName, action, detail: detail.slice(0, 300), subjectId }).catch((err: Error) =>
    console.warn('[audit] gagal mencatat:', err.message),
  );
}

/** Nama tampilan untuk jejak audit (ID mentah tidak berarti apa-apa di Google Sheet). */
export async function memberName(platform: string, groupId: string, id: string): Promise<string> {
  return (await MemberModel.findOne({ platform, groupId, platformUserId: id }, { displayName: 1 }).lean())?.displayName ?? id;
}
