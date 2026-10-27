import { AuditModel } from '../../db/models.ts';
import { now } from '../time.ts';

/** Catat tindakan penting. Gagal mencatat tidak boleh menggagalkan tindakannya. */
export async function audit(groupId: string, actor: { platformUserId: string; displayName: string }, action: string, detail = ''): Promise<void> {
  await AuditModel.create({ groupId, at: now(), actorId: actor.platformUserId, actorName: actor.displayName, action, detail: detail.slice(0, 300) }).catch((err: Error) =>
    console.warn('[audit] gagal mencatat:', err.message),
  );
}
