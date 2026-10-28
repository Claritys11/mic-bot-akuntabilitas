import { parseRelativeDate, type ParsedDate } from '../promises/dateParser.ts';
import { fromWIB, wibParts } from '../time.ts';

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
  /** Diajukan dari hari acaranya (tidak ada jam): malam sebelumnya / pagi harinya. */
  lead?: 'eve' | 'morning';
}

export function parseReminderRequest(text: string, now: Date): ReminderRequest | null {
  const m = text.match(TRIGGER);
  if (!m) return null;
  const after = text.slice(m.index! + m[0].length);
  const target = GROUP_WORDS.test(after.split(/\s+/).slice(0, 3).join(' ')) ? 'group' : 'self';
  return build(after, target, now);
}

// Obrolan biasa yang menandakan butuh diingatkan, tanpa men-tag bot:
// "jangan lupa besok bawa kartu pelajar" (ke teman sekelas) / "takut lupa, besok jam 7 piket".
const REMIND_OTHERS = /\b(?:jangan|jgn|ojo|aja)\s+(?:sampai\s+|sampe\s+)?(?:lupa|lali)\b/i;
const REMIND_SELF = /\b(?:takut|sering|suka|gampang)\s+(?:lupa|lali)\b|\b(?:biar|supaya|ben)\s+(?:gak|nggak|ga|ngga|enggak|tidak|ndak|ora)\s+(?:lupa|lali)\b|\blupa\s+terus\b/i;

const PAST_WORDS = /\b(?:tadi|kemarin|kemaren|wingi|barusan)\b/i;

/**
 * Pesan tanpa tag yang pantas ditawari pengingat → isi tawarannya. Hanya kalau waktunya jelas di masa
 * depan; tanpa waktu, menawarkan cuma jadi bising (bot terpaksa bertanya balik).
 */
export function detectReminderOffer(text: string, now: Date): ReminderRequest | null {
  // "jam 7 tadi pagi", "kemarin aku lupa…" → sudah lewat, bukan untuk diingatkan.
  if (PAST_WORDS.test(text)) return null;
  const explicit = parseReminderRequest(text, now);
  if (explicit) return explicit.at ? explicit : null;
  const m = text.match(REMIND_SELF) ?? text.match(REMIND_OTHERS);
  if (!m) return null;
  const target = REMIND_SELF.test(text) ? 'self' : 'group';
  // "besok ulangan, takut lupa" → isi ada sebelum pemicunya.
  const after = text.slice(m.index! + m[0].length);
  const fragment = /[\p{L}\d]/u.test(after.replace(TIME_PHRASES, ' ').replace(/\b(?:ya|yah|dong|deh|guys|gaes|rek|cuy)\b/gi, ' ')) ? after : text.slice(0, m.index!);
  const r = build(fragment, target, now, text);
  return r?.at ? r : null;
}

function build(fragment: string, target: 'self' | 'group', now: Date, whole = fragment): ReminderRequest | null {
  const parsed = parseRelativeDate(whole, now);
  const what = fragment
    .replace(/^\s*(?:aku|saya|gue|gw|ku|kita|kami|kelas|semua(?:nya)?|anak-anak|teman-teman|temen-temen|grup)\b/i, '')
    .replace(TIME_PHRASES, ' ')
    .replace(/\b(?:ya|yah|dong|deh|guys|gaes|tolong|please|pls)\b/gi, ' ')
    .replace(/\b(?:buat|untuk|soal|kalau|kalo|biar|supaya|bahwa|tentang)\b/gi, (w, offset: number) => (offset < 3 ? ' ' : w))
    .replace(/^[\s,.:;-]*(?:buat|untuk|soal|tentang|kalau|kalo|biar|supaya)?\s*/i, '')
    .replace(/\s+/g, ' ')
    // Sisa ungkapan waktu di ujung: "bayar kas sebelum (jumat)", "kumpul paling lambat (besok)".
    .replace(/(?:[\s,.;:!?-]+(?:ya|yah|dong|deh|aku|saya|gue|guys|gaes|rek|cuy|oke?|sebelum|sampai|sampe|paling\s+lambat|maks(?:imal)?|max|pas|saat|waktu|tiap|di|ke|hari))*[\s,.;:!?-]*$/i, '')
    .trim();
  if (!what) return null;
  const when = parsed ? reminderTime(parsed, now) : null;
  return { target, what: what.slice(0, 200), at: when?.at ?? null, ...(when?.lead && { lead: when.lead }) };
}

/**
 * Kapan mengingatkan. Tanpa jam ("besok ulangan") acaranya bisa pagi, jadi jam default janji (20.00)
 * baru datang setelah acaranya selesai → ingatkan malam sebelumnya; sudah lewat → pagi harinya.
 */
const EVE_HOUR = 19;
const MORNING_HOUR = 6;
export function reminderTime({ date, hasTime }: ParsedDate, now: Date): { at: Date; lead?: 'eve' | 'morning' } | null {
  const d = wibParts(date);
  const today = wibParts(now);
  const isToday = d.year === today.year && d.month === today.month && d.day === today.day;
  if (hasTime || isToday) return date > now ? { at: date } : null;
  const eve = fromWIB(d.year, d.month, d.day - 1, EVE_HOUR);
  if (eve > now) return { at: eve, lead: 'eve' };
  const morning = fromWIB(d.year, d.month, d.day, MORNING_HOUR);
  return morning > now ? { at: morning, lead: 'morning' } : null;
}
