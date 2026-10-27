import { GroupModel, KasProofModel, KasReminderModel, MemberModel, MessageBufferModel, OnboardingModel, OppPostModel, OpportunityModel, PromiseModel, TransactionModel, WaPromptModel } from '../../db/models.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { mention, type ActionEvent, type CommandInvocation, type Reply } from '../types.ts';

// Hak menarik persetujuan (UU PDP): data satu anggota atau seluruh kelas bisa dihapus kapan saja.
// Selalu dua langkah — perintah menampilkan apa yang akan dihapus, tombol yang benar-benar menghapus.

const ids = {
  member: (userId: string) => `d:mem:${userId}`,
  group: 'd:grp:all',
  cancel: 'd:no:x',
};

const DELETED = '(anggota dihapus)';

export interface DeleteReport {
  janji: number;
  buktiKas: number;
  pesanBuffer: number;
  transaksiDianonimkan: number;
}

/**
 * Hapus data satu anggota di satu kelas. Janji miliknya, bukti kas, jejak pengingat, pesan di buffer,
 * dan data anggotanya dihapus. Transaksi ledger tidak dihapus (saldo kelas harus tetap benar) tapi
 * namanya dianonimkan — satu-satunya pengecualian aturan append-only, lewat driver langsung.
 */
export async function deleteMemberData(platform: string, groupId: string, userId: string): Promise<DeleteReport> {
  const member = await MemberModel.findOne({ platform, groupId, platformUserId: userId }).lean();
  const [janji, bukti, buffer, tx] = await Promise.all([
    PromiseModel.deleteMany({ groupId, 'owner.platformUserId': userId }),
    KasProofModel.deleteMany({ groupId, 'member.platformUserId': userId }),
    member ? MessageBufferModel.deleteMany({ groupId, authorName: member.displayName }) : Promise.resolve({ deletedCount: 0 }),
    TransactionModel.collection.updateMany({ groupId, memberId: userId }, { $set: { memberId: null, memberName: DELETED } }),
  ]);
  await Promise.all([
    // Janji milik orang lain yang dibuat anggota ini tetap ada, tapi pembuatnya dianonimkan.
    PromiseModel.updateMany({ groupId, 'createdBy.platformUserId': userId }, { $set: { createdBy: { platformUserId: 'deleted', displayName: DELETED } } }),
    KasReminderModel.deleteMany({ groupId, memberId: userId }),
    MemberModel.deleteOne({ platform, groupId, platformUserId: userId }),
    GroupModel.updateOne({ platform, groupId, 'kas.treasurerId': userId }, { $set: { 'kas.treasurerId': null } }),
  ]);
  return { janji: janji.deletedCount, buktiKas: bukti.deletedCount, pesanBuffer: buffer.deletedCount, transaksiDianonimkan: tx.modifiedCount };
}

/** Hapus SEMUA data kelas: profil, anggota, janji, kas (termasuk ledger), buffer, info lomba kelas ini. */
export async function deleteGroupData(platform: string, groupId: string): Promise<number> {
  const results = await Promise.all([
    PromiseModel.deleteMany({ groupId }),
    KasProofModel.deleteMany({ groupId }),
    TransactionModel.collection.deleteMany({ groupId }),
    KasReminderModel.deleteMany({ groupId }),
    MessageBufferModel.deleteMany({ groupId }),
    MemberModel.deleteMany({ platform, groupId }),
    OpportunityModel.deleteMany({ groupId }),
    OppPostModel.deleteMany({ groupId }),
    OnboardingModel.deleteMany({ platform, groupId }),
    WaPromptModel.deleteMany({ groupId }),
    GroupModel.deleteMany({ platform, groupId }),
  ]);
  return results.reduce((n, r) => n + r.deletedCount, 0);
}

const confirmButtons = (yesId: string) => [
  { id: yesId, label: '🗑️ Ya, hapus permanen', kind: 'danger' as const },
  { id: ids.cancel, label: 'Batal', kind: 'secondary' as const },
];

export async function dataHapusSaya(cmd: CommandInvocation): Promise<Reply> {
  return {
    reply: {
      private: true,
      text:
        `Ini akan menghapus permanen datamu di kelas ini: janji milikmu, bukti kas, pesan di rangkuman, dan data anggotamu. ` +
        `Catatan kas kelas tetap ada (supaya saldo benar) tapi namamu diganti "${DELETED}". Lanjut?`,
      actions: confirmButtons(ids.member(cmd.actor.platformUserId)),
    },
  };
}

export async function dataHapusAnggota(cmd: CommandInvocation): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Hanya pengurus kelas yang bisa menghapus data anggota lain. Untuk datamu sendiri: `/data hapus-saya`.', private: true } };
  const target = cmd.options.anggota as string | undefined;
  if (!target) return { reply: { text: 'Sebut anggotanya (tag).', private: true } };
  return {
    reply: {
      private: true,
      text: `Hapus permanen data ${mention({ platformUserId: target })} di kelas ini (janji, bukti kas, pesan di rangkuman; nama di catatan kas dianonimkan)?`,
      actions: confirmButtons(ids.member(target)),
    },
  };
}

export async function dataHapusKelas(cmd: CommandInvocation): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Hanya pengurus kelas yang bisa menghapus data kelas.', private: true } };
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  return {
    reply: {
      private: true,
      text: `⚠️ Hapus permanen SEMUA data ${group.className}: profil kelas, anggota, janji, kas & ledger, rangkuman, info lomba kelas ini. Tidak bisa dibatalkan. Ekspor dulu kalau perlu (\`/kas ekspor\`, \`/pilot ekspor\`).`,
      actions: confirmButtons(ids.group),
    },
  };
}

export async function handleDataAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, arg] = ev.actionId.split(':');
  if (verb === 'no') return { update: { text: 'Dibatalkan. Tidak ada data yang dihapus.', actions: [] } };
  if (verb === 'mem' && arg) {
    // Diperiksa ulang saat tombol ditekan: hanya orangnya sendiri atau pengurus.
    if (arg !== ev.actor.platformUserId && !ev.isAdmin) return { reply: { text: 'Kamu hanya bisa menghapus datamu sendiri.', private: true } };
    const r = await deleteMemberData(ev.platform, ev.groupId, arg);
    console.log(`[privasi] data anggota dihapus di ${ev.groupId} oleh ${ev.actor.platformUserId}: ${JSON.stringify(r)}`);
    return {
      update: {
        text: `✅ Data dihapus: ${r.janji} janji, ${r.buktiKas} bukti kas, ${r.pesanBuffer} pesan; ${r.transaksiDianonimkan} catatan kas dianonimkan.`,
        actions: [],
      },
    };
  }
  if (verb === 'grp') {
    if (!ev.isAdmin) return { reply: { text: 'Hanya pengurus kelas yang bisa menghapus data kelas.', private: true } };
    const n = await deleteGroupData(ev.platform, ev.groupId);
    console.log(`[privasi] SEMUA data kelas ${ev.groupId} dihapus oleh ${ev.actor.platformUserId} (${n} dokumen)`);
    return { update: { text: `✅ Semua data kelas ini dihapus (${n} catatan). Tag aku + "setup" kalau mau mulai lagi.`, actions: [] } };
  }
  return { reply: { text: 'Aksi tidak dikenal.', private: true } };
}
