import { GroupModel } from '../../db/models.ts';
import type { PlatformOps } from '../types.ts';

// Tempat bendahara mengecek bukti transfer: DM ke orangnya, atau channel privat "tim inti".
// Channel dicari dulu (biar tidak dobel); kalau belum ada dan platform bisa, dibuatkan.

export const TEAM_CHANNEL_NAMES = ['tim-inti', 'pengurus', 'pengurus-kelas', 'bendahara', 'kas-pengurus'];

export interface ReviewChannel {
  channelId: string;
  created: boolean;
  /** Anggota biasa tidak bisa melihat → siapa pun di channel itu dianggap tim inti. */
  private: boolean;
}

/**
 * Pakai channel yang disebut, atau cari channel tim inti yang sudah ada, atau buat baru (privat).
 * null kalau platform tidak punya channel (WhatsApp) atau bot tidak punya izin.
 */
export async function ensureReviewChannel(
  ops: PlatformOps,
  input: { groupId: string; nearChannelId: string; allowUserIds: string[]; channelId?: string | null },
): Promise<ReviewChannel | null> {
  const isPrivate = async (id: string) => (ops.isPrivateChannel ? await ops.isPrivateChannel(input.groupId, id).catch(() => false) : false);
  if (input.channelId) return { channelId: input.channelId, created: false, private: await isPrivate(input.channelId) };
  const existing = ops.findChannel ? await ops.findChannel(input.groupId, TEAM_CHANNEL_NAMES).catch(() => null) : null;
  if (existing) return { channelId: existing, created: false, private: await isPrivate(existing) };
  if (!ops.createPrivateChannel) return null;
  const id = await ops.createPrivateChannel(
    input.groupId,
    'tim-inti',
    'Channel pengurus kelas — bukti kas dicek di sini oleh bendahara. Dibuat MIC-Bot 🔒',
    input.nearChannelId,
    input.allowUserIds.filter(Boolean),
  );
  return id ? { channelId: id, created: true, private: true } : null;
}

/** Simpan tempat cek bukti; `reviewerIds` = tim inti yang boleh menyetujui selain bendahara & admin. */
export async function saveReviewTarget(
  platform: string,
  groupId: string,
  target: { mode: 'dm' | 'channel'; channel?: ReviewChannel | null; reviewerIds?: string[] },
): Promise<void> {
  const channel = target.mode === 'channel' ? (target.channel ?? null) : null;
  const reviewers = [...new Set((target.reviewerIds ?? []).filter(Boolean))];
  await GroupModel.updateOne(
    { platform, groupId },
    {
      $set: { 'kas.reviewChannelId': channel?.channelId ?? null, 'kas.reviewChannelPrivate': channel?.private ?? false },
      ...(reviewers.length ? { $addToSet: { 'kas.reviewerIds': { $each: reviewers } } } : {}),
    },
  );
}

/** Tambah anggota tim inti: boleh menyetujui bukti, dan (kalau bisa) diberi akses ke channel tim inti. */
export async function addReviewer(ops: PlatformOps, platform: string, groupId: string, userId: string, channelId: string | null): Promise<boolean> {
  await GroupModel.updateOne({ platform, groupId }, { $addToSet: { 'kas.reviewerIds': userId } });
  if (!channelId || !ops.allowUserInChannel) return false;
  return ops.allowUserInChannel(groupId, channelId, userId).catch(() => false);
}
