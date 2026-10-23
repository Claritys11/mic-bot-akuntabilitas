import { MessageBufferModel } from '../../db/models.ts';

// Konteks obrolan terakhir untuk membaca suasana. Sumbernya buffer ber-TTL 48 jam yang sama
// dengan rangkuman — tidak ada penyimpanan baru (prinsip privasi).

const WINDOW_MS = 2 * 3600_000;

export interface RecentLine {
  author: string;
  text: string;
}

/** Pesan-pesan sebelum `before` di channel yang sama (lama → baru), maks `limit`, dalam 2 jam terakhir. */
export async function recentChat(groupId: string, channelId: string, before: Date, limit = 10): Promise<RecentLine[]> {
  const rows = await MessageBufferModel.find({
    groupId,
    channelId,
    createdAt: { $lt: before, $gte: new Date(before.getTime() - WINDOW_MS) },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return rows.reverse().map((r) => ({ author: r.authorName, text: r.text.slice(0, 300) }));
}

export const asTranscript = (lines: RecentLine[]) => lines.map((l) => `${l.author}: ${l.text}`);
