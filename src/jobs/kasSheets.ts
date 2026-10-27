import { listMembers } from '../core/groups.ts';
import { buildKasSheet, sheetMarker } from '../core/kas/sheet.ts';
import { ledgerEntries, rateOf } from '../core/kas/service.ts';
import { FLAG_TEXT, type ProofFlag } from '../core/kas/verify.ts';
import { now } from '../core/time.ts';
import type { Platform } from '../core/types.ts';
import { AuditModel, GroupModel, KasProofModel, type GroupDoc } from '../db/models.ts';
import { PUBLIC_REASON, SheetsError, type SheetsClient } from '../integrations/google/sheets.ts';

// Tulis ulang Google Sheet kas tiap kelas yang ditandai "dirty" (dicek tiap menit, aman restart).

export async function syncKasSheet(client: SheetsClient, g: GroupDoc): Promise<void> {
  const [members, entries, proofs, audits] = await Promise.all([
    listMembers(g.platform as Platform, g.groupId),
    ledgerEntries(g.groupId),
    KasProofModel.find({ groupId: g.groupId }, { createdAt: 1, member: 1, nominal: 1, period: 1, status: 1, flags: 1 }).sort({ createdAt: -1 }).limit(500).lean(),
    AuditModel.find({ groupId: g.groupId, action: /^(kas|tim)\./ }).sort({ at: -1 }).limit(300).lean(),
  ]);
  const tabs = buildKasSheet({
    className: g.className,
    marker: sheetMarker(g.platform, g.groupId),
    amount: g.kas?.amount ?? 0,
    rate: rateOf(g),
    period: (g.kas?.period ?? 'bulanan') as 'bulanan' | 'mingguan',
    now: now(),
    members: members.map((m) => ({ id: m.platformUserId, name: m.displayName })),
    entries,
    proofs: proofs.map((p) => ({ createdAt: p.createdAt as Date, memberName: p.member.displayName, nominal: p.nominal ?? null, period: p.period, status: p.status, flags: p.flags })),
    flagText: (f) => FLAG_TEXT[f as ProofFlag] ?? f,
    audits: audits.map((a) => ({ at: a.at, actorName: a.actorName, action: a.action, detail: a.detail ?? '' })),
  });
  // Sheet dibuat publik setelah ditautkan → berhenti menulis sampai aksesnya dibatasi lagi.
  if ((await client.publicAccess(g.kas!.sheetId!)) !== 'private') throw new Error(PUBLIC_REASON);
  // Cek lagi pemiliknya tepat sebelum menimpa (sheet bisa dipindah/ditiru setelah ditautkan).
  const marker = await client.readMarker(g.kas!.sheetId!);
  if (marker && marker !== sheetMarker(g.platform, g.groupId)) throw new Error('sheet ini milik kelas lain — sambungkan Google Sheet baru lewat /kas sheet');
  await client.writeTabs(g.kas!.sheetId!, tabs);
}

export function startKasSheetJob(client: SheetsClient): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const groups = await GroupModel.find({ 'kas.sheetId': { $ne: null }, 'kas.sheetDirtyAt': { $ne: null } }).lean<GroupDoc[]>();
      for (const g of groups) {
        const k = g.kas!;
        if (k.sheetSyncedAt && k.sheetDirtyAt! <= k.sheetSyncedAt) continue;
        const startedAt = new Date();
        try {
          await syncKasSheet(client, g);
          await GroupModel.updateOne({ _id: g._id }, { $set: { 'kas.sheetSyncedAt': startedAt, 'kas.sheetError': null } });
        } catch (err) {
          const msg = err instanceof SheetsError && err.status === 403 ? `akses ditolak — bagikan lagi ke ${client.serviceEmail} sebagai Editor` : (err as Error).message.slice(0, 200);
          console.error(`[sheets] ${g.className}: ${msg}`);
          // Tandai sudah dicoba supaya tidak mengulang tiap menit; perubahan berikutnya mencoba lagi.
          await GroupModel.updateOne({ _id: g._id }, { $set: { 'kas.sheetSyncedAt': startedAt, 'kas.sheetError': msg } });
        }
      }
    } catch (err) {
      console.error('[sheets] job gagal:', (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  setTimeout(tick, 10_000);
  console.log(`[sheets] laporan kas Google Sheets aktif (akun layanan ${client.serviceEmail})`);
  return () => clearInterval(timer);
}
