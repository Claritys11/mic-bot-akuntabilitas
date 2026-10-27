import type { GroupDoc } from '../../db/models.ts';

// Peran tim inti disimpan bot — ketua kelas belum tentu admin server Discord / grup WhatsApp.
// Izin (lihat tabel di PLAN.md):
//   kelola: profil kelas, peran, pilot, jam tenang, hapus data anggota → admin, ketua
//   kas:    atur iuran, setujui bukti, catat arus kas, Google Sheet   → admin, bendahara (+ tim inti kas lama)
//   lomba:  simpan/buang/tambah info lomba, sumber lomba              → admin, ketua, sekretaris

export const ROLES = ['ketua', 'bendahara', 'sekretaris'] as const;
export type Role = (typeof ROLES)[number];
export type Ability = 'kelola' | 'kas' | 'lomba';

export const ROLE_LABEL: Record<Role, string> = { ketua: '👑 Ketua', bendahara: '💰 Bendahara', sekretaris: '📝 Sekretaris' };
export const MAX_PER_ROLE: Record<Role, number> = { ketua: 2, bendahara: 2, sekretaris: 2 };

type GroupRoles = Pick<GroupDoc, 'roles' | 'kas'>;

export function rolesOf(group: GroupRoles | null | undefined, userId: string): Role[] {
  const r: Role[] = ROLES.filter((role) => group?.roles?.[role]?.includes(userId));
  if (group?.kas?.treasurerId === userId && !r.includes('bendahara')) r.push('bendahara');
  return r;
}

export function can(group: GroupRoles | null | undefined, ctx: { isAdmin: boolean; actor: { platformUserId: string } }, ability: Ability): boolean {
  if (ctx.isAdmin) return true;
  const r = rolesOf(group, ctx.actor.platformUserId);
  if (ability === 'kelola') return r.includes('ketua');
  if (ability === 'lomba') return r.includes('ketua') || r.includes('sekretaris');
  return r.includes('bendahara') || Boolean(group?.kas?.reviewerIds?.includes(ctx.actor.platformUserId));
}
