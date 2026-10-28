import type { OutgoingMessage, Sender } from '../core/types.ts';

/**
 * Kirim berurutan. Satu pesan gagal tidak menggugurkan yang lain, KECUALI pesan yang menandai
 * `onlyIfPreviousSent` — itu diganti `elseText` (kalau ada) supaya bot tidak mengklaim hal yang gagal.
 */
export async function sendAll(sender: Sender, messages: OutgoingMessage[], tag: string, opts: { beforeSend?: (m: OutgoingMessage) => Promise<void> } = {}): Promise<number> {
  let previousOk = true;
  let sent = 0;
  for (const m of messages) {
    let msg: OutgoingMessage | null = m;
    if (m.onlyIfPreviousSent && !previousOk) msg = m.elseText ? { to: m.to, text: m.elseText } : null;
    if (!msg) {
      previousOk = false;
      continue;
    }
    try {
      // Indikator "mengetik" gagal tidak boleh menggagalkan pesannya.
      if (opts.beforeSend) await opts.beforeSend(msg).catch(() => undefined);
      await sender.send(msg);
      previousOk = msg === m;
      sent++;
      if (msg === m && m.afterSend) await m.afterSend().catch((err: Error) => console.error(`[${tag}] afterSend gagal:`, err.message));
    } catch (err) {
      previousOk = false;
      console.error(`[${tag}] gagal kirim:`, (err as Error).message);
    }
  }
  return sent;
}
