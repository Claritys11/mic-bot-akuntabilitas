import { GroupModel, type GroupDoc } from '../../db/models.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { addReviewer, removeReviewer } from '../kas/review.ts';
import { markKasDirty } from '../kas/service.ts';
import { channelRef, mention, type CommandInvocation, type PlatformOps, type Reply } from '../types.ts';
import { audit, memberName } from './audit.ts';
import { can, MAX_PER_ROLE, ROLE_LABEL, ROLES, type Role } from './roles.ts';

const deny = (text: string): Reply => ({ reply: { text, private: true } });


function teamCard(g: GroupDoc) {
  const people = (ids: string[]) => (ids.length ? ids.map((id) => mention({ platformUserId: id })).join(', ') : '—');
  const bendahara = [...new Set([...(g.kas?.treasurerId ? [g.kas.treasurerId] : []), ...(g.roles?.bendahara ?? [])])];
  return {
    title: `👥 Tim inti ${g.className}`,
    tone: 'info' as const,
    fields: [
      { name: ROLE_LABEL.ketua, value: people(g.roles?.ketua ?? []), inline: true },
      { name: ROLE_LABEL.bendahara, value: people(bendahara), inline: true },
      { name: ROLE_LABEL.sekretaris, value: people(g.roles?.sekretaris ?? []), inline: true },
      { name: 'Cek bukti kas di', value: g.kas?.reviewChannelId ? channelRef(g.kas.reviewChannelId) : 'DM bendahara', inline: true },
    ],
    footer: 'Ketua: atur kelas & peran · Bendahara: kas · Sekretaris: info lomba. Admin server boleh semua. Ubah: /tim tambah · /tim hapus',
  };
}

export async function timLihat(cmd: CommandInvocation): Promise<Reply> {
  const g = await getGroup(cmd.platform, cmd.groupId);
  if (!g) return deny(NOT_SETUP_TEXT);
  return { reply: { card: teamCard(g), private: true } };
}

export async function timTambah(cmd: CommandInvocation, ops: PlatformOps = {}): Promise<Reply> {
  const g = await getGroup(cmd.platform, cmd.groupId);
  if (!g) return deny(NOT_SETUP_TEXT);
  if (!can(g, cmd, 'kelola')) return deny('Yang bisa mengatur tim inti: ketua kelas atau admin server.');
  const role = cmd.options.peran as Role;
  const who = cmd.options.anggota as string | undefined;
  if (!ROLES.includes(role) || !who) return deny('Pilih peran & tag anggotanya.');
  const current = role === 'bendahara' ? new Set([...(g.roles?.bendahara ?? []), ...(g.kas?.treasurerId ? [g.kas.treasurerId] : [])]) : new Set(g.roles?.[role] ?? []);
  if (current.has(who)) return deny(`${mention({ platformUserId: who })} sudah jadi ${role}.`);
  if (current.size >= MAX_PER_ROLE[role]) return deny(`${ROLE_LABEL[role]} maksimal ${MAX_PER_ROLE[role]} orang. Hapus dulu salah satunya: /tim hapus`);
  await GroupModel.updateOne(
    { _id: g._id },
    { $addToSet: { [`roles.${role}`]: who }, ...(role === 'bendahara' && !g.kas?.treasurerId ? { $set: { 'kas.treasurerId': who } } : {}) },
  );
  let note = '';
  if (role === 'bendahara' && g.kas?.reviewChannelId) {
    const ok = await addReviewer(ops, cmd.platform, cmd.groupId, who, g.kas.reviewChannelId);
    note = ok ? ` Sudah bisa melihat ${channelRef(g.kas.reviewChannelId)}.` : ` Beri dia akses ${channelRef(g.kas.reviewChannelId)} lewat pengaturan channel ya.`;
  }
  await audit(cmd.groupId, cmd.actor, 'tim.tambah', `${role}: ${await memberName(cmd.platform, cmd.groupId, who)}`);
  if (role === 'bendahara') await markKasDirty(cmd.groupId);
  const fresh = (await getGroup(cmd.platform, cmd.groupId))!;
  return { reply: { text: `✅ ${mention({ platformUserId: who })} sekarang ${ROLE_LABEL[role]}.${note}`, card: teamCard(fresh) } };
}

export async function timHapus(cmd: CommandInvocation): Promise<Reply> {
  const g = await getGroup(cmd.platform, cmd.groupId);
  if (!g) return deny(NOT_SETUP_TEXT);
  if (!can(g, cmd, 'kelola')) return deny('Yang bisa mengatur tim inti: ketua kelas atau admin server.');
  const who = cmd.options.anggota as string | undefined;
  if (!who) return deny('Tag anggotanya.');
  const role = cmd.options.peran as Role | undefined;
  const roles = role ? [role] : [...ROLES];
  const set: Record<string, unknown> = {};
  if (roles.includes('bendahara') && g.kas?.treasurerId === who) {
    // Bendahara utama dicopot → pindah ke bendahara lain (kalau ada).
    set['kas.treasurerId'] = (g.roles?.bendahara ?? []).find((id) => id !== who) ?? null;
  }
  await GroupModel.updateOne({ _id: g._id }, { $pull: Object.fromEntries(roles.map((r) => [`roles.${r}`, who])), ...(Object.keys(set).length ? { $set: set } : {}) });
  if (roles.includes('bendahara')) await removeReviewer(cmd.platform, cmd.groupId, who);
  await audit(cmd.groupId, cmd.actor, 'tim.hapus', `${role ?? 'semua peran'}: ${await memberName(cmd.platform, cmd.groupId, who)}`);
  const fresh = (await getGroup(cmd.platform, cmd.groupId))!;
  const lostChannel = roles.includes('bendahara') && g.kas?.reviewChannelId ? ` Cabut juga aksesnya ke ${channelRef(g.kas.reviewChannelId)} kalau perlu.` : '';
  return { reply: { text: `✅ ${mention({ platformUserId: who })} dicopot dari ${role ?? 'semua peran tim inti'}.${lostChannel}`, card: teamCard(fresh) } };
}
