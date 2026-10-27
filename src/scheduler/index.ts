import type { Core } from '../core/index.ts';
import { timeScale } from '../core/time.ts';
import type { Sender } from '../core/types.ts';
import { beat } from '../db/health.ts';

// Polling tiap 60 detik ke koleksi persisten (Promise, Group kas, Opportunity) → aman restart:
// status tahap disimpan di DB, jadi tidak ada timer di memori yang hilang saat bot mati.

/** Tick gagal berturut-turut sebanyak ini → lapor ke operator (sekali, sampai pulih). */
const ALERT_AFTER_FAILURES = 3;

export function startScheduler(core: Core, sender: Sender, baseIntervalMs = 60_000, alert?: (text: string) => void): () => void {
  // Saat demo dipercepat, polling ikut dipercepat (minimal 5 detik).
  const interval = Math.max(5_000, Math.round(baseIntervalMs / timeScale()));
  let running = false;
  let failures = 0;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const messages = await core.tick();
      await beat();
      if (failures >= ALERT_AFTER_FAILURES) alert?.('✅ Scheduler MIC-Bot pulih.');
      failures = 0;
      for (const m of messages) {
        await sender.send(m).catch((err) => console.error('[scheduler] gagal kirim:', (err as Error).message));
      }
      if (messages.length) console.log(`[scheduler] ${messages.length} pesan terkirim`);
    } catch (err) {
      console.error('[scheduler] tick gagal:', err);
      if (++failures === ALERT_AFTER_FAILURES) alert?.(`⚠️ Scheduler MIC-Bot gagal ${failures}x berturut-turut: ${(err as Error).message?.slice(0, 200)}. Pengingat tidak terkirim sampai pulih.`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(run, interval);
  setTimeout(run, 3_000);
  console.log(`[scheduler] aktif, interval ${interval / 1000} detik`);
  return () => clearInterval(timer);
}
