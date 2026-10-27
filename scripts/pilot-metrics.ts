// Metrik pilot per kelas: bun run pilot:metrics [--dari 2026-11-01] [--sampai 2026-11-30]
// Kelas = kontrolnya sendiri: minggu "diam" (baseline, shadow) vs minggu aktif (lihat docs/PILOT.md).
import { loadConfig } from '../src/config.ts';
import { pilotMetrics } from '../src/core/pilot/metrics.ts';
import { connectDb, disconnectDb } from '../src/db/connect.ts';
import { GroupModel, KasProofModel, PromiseModel } from '../src/db/models.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = new Date(`${arg('--dari') ?? '2000-01-01'}T00:00:00+07:00`);
const to = new Date(`${arg('--sampai') ?? '2100-01-01'}T23:59:59+07:00`);
const now = new Date(Math.min(Date.now(), to.getTime()));

await connectDb(loadConfig().mongoUri);
const groups = await GroupModel.find().lean();
for (const g of groups) {
  const range = { $gte: from, $lte: to };
  const [promises, proofs] = await Promise.all([
    PromiseModel.find({ groupId: g.groupId, createdAt: range }, { status: 1, deadline: 1, doneAt: 1, createdAt: 1, autoActivated: 1, ownerTouched: 1, shadow: 1 }).lean(),
    KasProofModel.find({ groupId: g.groupId, createdAt: range }, { status: 1, nominal: 1, flags: 1 }).lean(),
  ]);
  const baseline = promises.filter((p) => p.shadow);
  const m = pilotMetrics(promises.filter((p) => !p.shadow) as never, proofs as never, now);
  console.log(`\n${g.className} (${g.platform})`);
  if (baseline.length) {
    console.log(`  BASELINE (mode diam): ${baseline.length} janji tercatat — ketepatannya dari kolom cek ketua di /pilot ekspor (bot tidak menanyakan "selesai" saat diam)`);
  }
  console.log('  MODE AKTIF:');
  console.log(`  janji tercatat ${m.recorded} · jatuh tempo ${m.due} · tepat ${m.onTime} · telat ${m.late} · lewat ${m.missed}`);
  console.log(`  ditepati tepat waktu: ${m.keptPct ?? '—'}% · rata-rata telat: ${m.avgDaysLate ?? '—'} hari · ditanya tapi tak dikonfirmasi: ${m.neverConfirmed}`);
  console.log(`  auto-aktif ${m.autoActivated} · salah-aktif ${m.falseActivations} (${m.falseActivationPct ?? '—'}%)`);
  console.log(`  kas: disetujui ${m.kas.approved} (Rp${m.kas.approvedTotal.toLocaleString('id-ID')}) · ditolak ${m.kas.rejected} · ditandai ${m.kas.flagged} · menunggu ${m.kas.pending}`);
}
await disconnectDb();
