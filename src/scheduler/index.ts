import type { Core } from '../core/index.ts';
import { timeScale } from '../core/time.ts';
import type { Sender } from '../core/types.ts';

// Polling tiap 60 detik ke koleksi persisten (Promise, Group kas, Opportunity) → aman restart:
// status tahap disimpan di DB, jadi tidak ada timer di memori yang hilang saat bot mati.

export function startScheduler(core: Core, sender: Sender, baseIntervalMs = 60_000): () => void {
  // Saat demo dipercepat, polling ikut dipercepat (minimal 5 detik).
  const interval = Math.max(5_000, Math.round(baseIntervalMs / timeScale()));
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const messages = await core.tick();
      for (const m of messages) {
        await sender.send(m).catch((err) => console.error('[scheduler] gagal kirim:', (err as Error).message));
      }
      if (messages.length) console.log(`[scheduler] ${messages.length} pesan terkirim`);
    } catch (err) {
      console.error('[scheduler] tick gagal:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(run, interval);
  setTimeout(run, 3_000);
  console.log(`[scheduler] aktif, interval ${interval / 1000} detik`);
  return () => clearInterval(timer);
}
