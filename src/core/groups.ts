import { GroupModel, MemberModel, type GroupDoc } from '../db/models.ts';
import type { Context, Member, Platform, SpeechLevel } from './types.ts';

export async function getGroup(platform: Platform, groupId: string): Promise<GroupDoc | null> {
  return GroupModel.findOne({ platform, groupId }).lean<GroupDoc>();
}

export interface SetupInput {
  className: string;
  major: string;
  speechLevel: SpeechLevel;
  mainChannelId: string;
  kasChannelId?: string | null;
  oppsChannelId?: string | null;
}

export async function setupGroup(ctx: Context, input: SetupInput): Promise<GroupDoc> {
  const doc = await GroupModel.findOneAndUpdate(
    { platform: ctx.platform, groupId: ctx.groupId },
    {
      $set: {
        className: input.className,
        major: input.major.toUpperCase(),
        speechLevel: input.speechLevel,
        mainChannelId: input.mainChannelId,
        kasChannelId: input.kasChannelId ?? null,
        oppsChannelId: input.oppsChannelId ?? null,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean<GroupDoc>();
  return doc!;
}

export async function upsertMember(m: Member): Promise<void> {
  await MemberModel.updateOne(
    { platform: m.platform, groupId: m.groupId, platformUserId: m.platformUserId },
    { $set: { displayName: m.displayName, active: true } },
    { upsert: true },
  );
}

export async function upsertMembers(members: Member[]): Promise<void> {
  if (!members.length) return;
  await MemberModel.bulkWrite(
    members.map((m) => ({
      updateOne: {
        filter: { platform: m.platform, groupId: m.groupId, platformUserId: m.platformUserId },
        update: { $set: { displayName: m.displayName, active: true } },
        upsert: true,
      },
    })),
  );
}

export async function listMembers(platform: Platform, groupId: string): Promise<Member[]> {
  const rows = await MemberModel.find({ platform, groupId, active: true }).sort({ displayName: 1 }).lean();
  return rows.map((r) => ({
    platform: r.platform as Platform,
    groupId: r.groupId,
    platformUserId: r.platformUserId,
    displayName: r.displayName,
  }));
}

export async function findMemberByName(platform: Platform, groupId: string, name: string): Promise<Member | null> {
  const clean = name.replace(/^@/, '').trim();
  if (!clean) return null;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const r = await MemberModel.findOne({ platform, groupId, displayName: new RegExp(`^${escaped}`, 'i') }).lean();
  return r ? { platform, groupId, platformUserId: r.platformUserId, displayName: r.displayName } : null;
}

export const NOT_SETUP_TEXT = 'Kelas ini belum diatur. Minta pengurus kelas menjalankan `/setup` dulu ya 🙏';
