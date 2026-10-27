import { sendAll } from '../adapters/sendAll.ts';
import type { Core } from '../core/index.ts';
import type { Sender } from '../core/types.ts';

// Login Google laporan kas: cek tiap 5 detik apakah pengurus sudah memasukkan kode & menekan Izinkan.
// Status login ada di DB (SheetLink), jadi aman restart; Google sendiri membatasi ±5 detik per cek.

export function startSheetLinkJob(core: Core, sender: Sender, intervalMs = 5_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sendAll(sender, await core.pollSheetLinks(), 'sheets');
    } catch (err) {
      console.error('[sheets] cek login Google gagal:', (err as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
