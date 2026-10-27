import { parseRelativeDate } from '../promises/dateParser.ts';

// "@MIC ingetin aku besok jam 7 bawa proyektor" → { target: 'self', what: 'bawa proyektor', at }

const TRIGGER = /\b(?:tolong\s+)?(?:ingetin|ingatin|ingatkan|ingetke|elingke|remind(?:in)?|reminder(?:in)?)\b/i;
const GROUP_WORDS = /\b(kita|kami|kelas|semua(?:nya)?|anak-anak|teman-teman|temen-temen|grup)\b/i;
// Ungkapan waktu yang dibuang dari isi pengingat (dateParser yang membacanya).
const TIME_PHRASES =
  /\b(?:(?:hari\s+)?(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)(?:\s+depan)?|besok|sesuk|lusa|nanti|ntar|mengko|hari\s+ini|minggu\s+depan|(?:tgl|tanggal)\.?\s*\d{1,2}(?:\s+\w+)?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s+(?:hari|minggu)\s+lagi|(?:jam|pukul|pkl)\.?\s*\d{1,2}(?:[:.]\d{2})?|pagi|esuk|siang|sore|malam(?:\s+ini)?|bengi)\b/gi;

export const looksLikeReminderRequest = (text: string) => TRIGGER.test(text);

export interface ReminderRequest {
  target: 'self' | 'group';
  what: string;
  at: Date | null;
}

export function parseReminderRequest(text: string, now: Date): ReminderRequest | null {
  const m = text.match(TRIGGER);
  if (!m) return null;
  const after = text.slice(m.index! + m[0].length);
  const target = GROUP_WORDS.test(after.split(/\s+/).slice(0, 3).join(' ')) ? 'group' : 'self';
  const parsed = parseRelativeDate(after, now);
  const what = after
    .replace(/^\s*(?:aku|saya|gue|gw|ku|kita|kami|kelas|semua(?:nya)?|anak-anak|teman-teman|temen-temen|grup)\b/i, '')
    .replace(TIME_PHRASES, ' ')
    .replace(/\b(?:ya|yah|dong|deh|tolong|please|pls|buat|untuk|soal|kalau|kalo|biar|supaya|bahwa|tentang)\b/gi, (w, offset: number) => (offset < 3 ? ' ' : w))
    .replace(/^[\s,.:;-]*(?:buat|untuk|soal|tentang|kalau|kalo|biar|supaya)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,.;:!?-]+$/, '')
    .trim();
  if (!what) return null;
  return { target, what: what.slice(0, 200), at: parsed && parsed.date > now ? parsed.date : null };
}
