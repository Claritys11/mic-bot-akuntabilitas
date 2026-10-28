import type { OutgoingMessage } from '../core/types.ts';

// "Sedang mengetik…" sebelum bot menjawab: terasa seperti teman yang mengetik, tapi tidak bikin menunggu.

const MIN_MS = 600;
const MAX_MS = 2500;
const MS_PER_CHAR = 12;

/** Lama jeda mengetik untuk satu balasan; dikurangi waktu yang sudah terpakai menampilkan "mengetik" saat berpikir. */
export function typingDelayMs(text: string | undefined, alreadyTypingMs = 0): number {
  const want = Math.min(MAX_MS, Math.max(MIN_MS, (text?.length ?? 0) * MS_PER_CHAR));
  return Math.max(0, want - alreadyTypingMs);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Channel tujuan balasan (DM & thread baru tidak diberi indikator: tujuannya beda dari tempat orang menunggu). */
export const typingChannel = (m: OutgoingMessage): string | null => (m.to.kind === 'channel' ? m.to.channelId : null);
