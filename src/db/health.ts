import { DowntimeModel, HeartbeatModel } from './models.ts';

// Bot yang mati tidak bisa melapor saat mati. Jadi: scheduler mencatat detak tiap tick, dan saat bot
// menyala lagi, jeda sejak detak terakhir dicatat sebagai "mati" — dipakai untuk menilai data pilot.

const ID = 'bot';
/** Jeda lebih dari ini dianggap bot mati (restart biasa beberapa detik saja). */
export const DOWNTIME_MIN_MS = 30 * 60_000;

export async function beat(at = new Date()): Promise<void> {
  await HeartbeatModel.updateOne({ _id: ID }, { $set: { lastTick: at } }).catch(() => undefined);
}

/** Dipanggil saat start: catat masa mati kalau ada, lalu mulai detak baru. */
export async function recordStartup(at = new Date()): Promise<{ from: Date; minutes: number } | null> {
  const prev = await HeartbeatModel.findById(ID).lean();
  await HeartbeatModel.updateOne({ _id: ID }, { $set: { lastTick: at, startedAt: at } }, { upsert: true });
  if (!prev || at.getTime() - prev.lastTick.getTime() < DOWNTIME_MIN_MS) return null;
  const minutes = Math.round((at.getTime() - prev.lastTick.getTime()) / 60_000);
  await DowntimeModel.create({ from: prev.lastTick, to: at, minutes });
  return { from: prev.lastTick, minutes };
}
