import { GroupModel, type GroupDoc } from '../db/models.ts';
import { can } from './team/roles.ts';
import { wibParts } from './time.ts';

// Jam tenang: pengingat & pengumuman terjadwal tidak dikirim malam hari (pengguna anak sekolah).
// Pesan yang tertahan tidak hilang — kondisinya masih terpenuhi saat jam tenang selesai.
// Balasan langsung dan pengingat yang diminta sendiri ("ingetin aku jam 22") tetap jalan.

export interface QuietHours {
  enabled?: boolean | null;
  start?: number | null;
  end?: number | null;
}

export const DEFAULT_QUIET = { start: 21, end: 6 };

export function inQuietHours(at: Date, q: QuietHours | null | undefined): boolean {
  if (q?.enabled === false) return false;
  const start = q?.start ?? DEFAULT_QUIET.start;
  const end = q?.end ?? DEFAULT_QUIET.end;
  if (start === end) return false;
  const h = wibParts(at).hour;
  return start < end ? h >= start && h < end : h >= start || h < end; // melewati tengah malam
}

/** Kunci "platform:groupId" kelas yang sedang jam tenang. */
export async function quietGroupKeys(at: Date): Promise<Set<string>> {
  const groups = await GroupModel.find({}, { platform: 1, groupId: 1, quietHours: 1 }).lean<Pick<GroupDoc, 'platform' | 'groupId' | 'quietHours'>[]>();
  return new Set(groups.filter((g) => inQuietHours(at, g.quietHours)).map((g) => `${g.platform}:${g.groupId}`));
}

/** /jam-tenang mulai:21 selesai:6 | mati:ya — pengurus. */
export async function jamTenangCommand(cmd: import('./types.ts').CommandInvocation): Promise<import('./types.ts').Reply> {
  const group = await GroupModel.findOne({ platform: cmd.platform, groupId: cmd.groupId }).lean<GroupDoc>();
  if (!group) return { reply: { text: 'Kelas ini belum diatur. Jalankan /setup dulu ya.', private: true } };
  if (!can(group, cmd, 'kelola')) return { reply: { text: 'Hanya ketua kelas atau admin server yang bisa mengatur jam tenang.', private: true } };
  const cur = { enabled: group.quietHours?.enabled ?? true, start: group.quietHours?.start ?? DEFAULT_QUIET.start, end: group.quietHours?.end ?? DEFAULT_QUIET.end };
  const next = { ...cur };
  if (cmd.options.mati === true) next.enabled = false;
  if (cmd.options.mati === false) next.enabled = true;
  for (const [k, key] of [['mulai', 'start'], ['selesai', 'end']] as const) {
    const v = cmd.options[k];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 23) return { reply: { text: `${k} harus jam 0–23.`, private: true } };
    next[key] = v as number;
    next.enabled = true;
  }
  await GroupModel.updateOne({ _id: group._id }, { $set: { quietHours: next } });
  const text = next.enabled
    ? `🌙 Jam tenang: ${String(next.start).padStart(2, '0')}.00–${String(next.end).padStart(2, '0')}.00 WIB. Pengingat & pengumuman terjadwal ditahan sampai jam tenang selesai (tidak hilang). Balasan langsung & pengingat yang diminta sendiri tetap jalan.`
    : '🔔 Jam tenang dimatikan — pengingat bisa dikirim kapan saja.';
  return { reply: { text, private: true } };
}
