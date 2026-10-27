// Metrik pilot per kelas: bun run pilot:metrics [--dari 2026-11-01] [--sampai 2026-11-30]
// Kelas = kontrolnya sendiri: minggu "diam" (baseline, shadow) vs minggu aktif (lihat docs/PILOT.md).
import { loadConfig } from '../src/config.ts';
import { pilotMetrics } from '../src/core/pilot/metrics.ts';
import { connectDb, disconnectDb } from '../src/db/connect.ts';
import { GroupModel, KasProofModel, LlmUsageModel, PromiseModel } from '../src/db/models.ts';

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
// Biaya LLM nyata (dari OpenRouter) untuk slide model bisnis.
const dayKey = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const usage = await LlmUsageModel.find({ day: { $gte: dayKey(from), $lte: dayKey(now) } }).lean();
if (usage.length) {
  const days = new Set(usage.map((u) => u.day)).size;
  const sum = usage.reduce(
    (a, u) => ({ calls: a.calls + u.calls, cost: a.cost + u.costUsd, ms: a.ms + u.totalMs, unpriced: a.unpriced + u.unpricedCalls }),
    { calls: 0, cost: 0, ms: 0, unpriced: 0 },
  );
  const active = Math.max(1, groups.length);
  const perClassMonth = (sum.cost / days / active) * 30;
  console.log(`\nBiaya LLM (${days} hari tercatat, ${groups.length} kelas)`);
  console.log(`  ${sum.calls} panggilan · rata-rata ${Math.round(sum.ms / sum.calls)} ms · total $${sum.cost.toFixed(4)}${sum.unpriced ? ` (+${sum.unpriced} panggilan tanpa data biaya)` : ''}`);
  console.log(`  ≈ $${perClassMonth.toFixed(3)} per kelas per bulan (≈ Rp${Math.round(perClassMonth * 16500).toLocaleString('id-ID')} dengan kurs Rp16.500)`);
  for (const u of usage.sort((a, b) => a.day.localeCompare(b.day))) console.log(`  ${u.day} ${u.model}: ${u.calls} panggilan, $${u.costUsd.toFixed(4)}`);
}
await disconnectDb();
