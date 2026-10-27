import { GroupModel, PromiseModel, type PromiseDoc } from '../../db/models.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { csvCell } from '../kas/ledger.ts';
import { formatWIB, now } from '../time.ts';
import type { CommandInvocation, Reply } from '../types.ts';

// Pilot dengan kelas sebagai kontrolnya sendiri: minggu 1 mode 'diam' (bot mencatat janji tanpa
// membalas/menagih = baseline), minggu 2–3 mode aktif. Lihat docs/PILOT.md.

export async function pilotMode(cmd: CommandInvocation): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Hanya pengurus kelas yang bisa mengubah mode pilot.', private: true } };
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const mode = cmd.options.mode === 'diam' ? 'diam' : cmd.options.mode === 'jeda' ? 'jeda' : 'off';
  const previous = group.pilotMode ?? 'off';
  await GroupModel.updateOne({ _id: group._id }, { $set: { pilotMode: mode } });
  const text = {
    diam: '🤫 Mode diam aktif: aku hanya mencatat janji di obrolan, tanpa membalas, menagih, atau mengirim pengingat kas/lomba. Janji yang tercatat bisa diekspor dengan `/pilot ekspor`.',
    jeda: '⏸️ Bot dijeda di kelas ini: aku tidak membaca, mencatat, membalas, atau menagih apa pun sampai `/pilot mode aktif`. Pengingat yang terlewat selama jeda tidak dikirim beruntun.',
    off:
      previous === 'diam'
        ? '🔔 Mode aktif: aku kembali membalas & menagih seperti biasa. Janji dari masa diam tetap tidak ditagih (biar baseline bersih).'
        : previous === 'jeda'
          ? '▶️ Jeda dibuka: aku aktif lagi. Pengingat yang terlewat tidak dikirim beruntun — hanya tahap terbaru.'
          : '🔔 Bot sudah dalam mode aktif.',
  }[mode];
  console.log(`[pilot] ${group.className}: mode ${mode} oleh ${cmd.actor.displayName}`);
  return { reply: { private: true, text } };
}

type CsvRow = Pick<PromiseDoc, 'task' | 'owner' | 'deadline' | 'status' | 'doneAt' | 'shadow' | 'autoActivated'> & { createdAt?: Date };

export function promisesCsv(rows: CsvRow[]): string {
  const head = ['dibuat', 'tugas', 'pemilik', 'deadline', 'status', 'selesai', 'mode', 'auto_aktif', 'dicek_ketua_ditepati'];
  const lines = rows.map((p) =>
    [
      p.createdAt ? formatWIB(p.createdAt, 'iso') : '',
      p.task,
      p.owner.displayName,
      p.deadline ? formatWIB(p.deadline, 'iso') : '',
      p.status,
      p.doneAt ? formatWIB(p.doneAt, 'iso') : '',
      p.shadow ? 'diam' : 'aktif',
      p.autoActivated ? 'ya' : 'tidak',
      '', // diisi ketua saat mengecek sampel acak (self-report "selesai" tidak cukup)
    ]
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

export async function pilotEkspor(cmd: CommandInvocation): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Ekspor data pilot hanya untuk pengurus kelas.', private: true } };
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const rows = await PromiseModel.find({ groupId: cmd.groupId, status: { $ne: 'pending_confirm' } }).sort({ createdAt: 1 }).lean<(PromiseDoc & { createdAt: Date })[]>();
  return {
    reply: {
      private: true,
      text: `${rows.length} janji tercatat. Kolom terakhir untuk ketua: cek beberapa janji acak, isi ya/tidak apakah benar ditepati.`,
      file: { name: `pilot-${group.className.replace(/\s+/g, '_')}-${formatWIB(now(), 'iso').slice(0, 10)}.csv`, content: promisesCsv(rows) },
    },
  };
}
