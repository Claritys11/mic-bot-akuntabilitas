import { fromWIB, wibParts } from '../time.ts';

export interface ParsedDate {
  date: Date;
  /** true kalau jam/bagian hari disebut; kalau tidak, jam default dipakai. */
  hasTime: boolean;
}

export const DEFAULT_HOUR = 20;

// Senin = 0 … Minggu = 6 (minggu kalender Indonesia mulai Senin)
const HARI: Record<string, number> = {
  senin: 0, selasa: 1, rabu: 2, kamis: 3, jumat: 4, sabtu: 5, minggu: 6, ahad: 6,
};

const BULAN: Record<string, number> = {
  jan: 0, januari: 0, feb: 1, februari: 1, mar: 2, maret: 2, apr: 3, april: 3, mei: 4,
  jun: 5, juni: 5, jul: 6, juli: 6, agu: 7, agt: 7, agustus: 7, sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9, nov: 10, november: 10, des: 11, desember: 11,
};

const PERIOD_HOUR: Record<string, number> = { pagi: 8, siang: 12, sore: 16, malam: 20 };

interface DayRef {
  year: number;
  month: number;
  day: number;
}

function addDays(base: DayRef, n: number): DayRef {
  const d = new Date(Date.UTC(base.year, base.month, base.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

const sameDay = (a: DayRef, b: DayRef) => a.year === b.year && a.month === b.month && a.day === b.day;

const isBefore = (a: DayRef, b: DayRef) =>
  Date.UTC(a.year, a.month, a.day) < Date.UTC(b.year, b.month, b.day);

function findDay(t: string, today: DayRef, mondayIdx: number): DayRef | null {
  let m: RegExpMatchArray | null;

  // 30/10, 30-10-2026
  if ((m = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : today.year;
      if (!m[3] && isBefore({ year, month, day }, today)) year += 1;
      return { year, month, day };
    }
  }

  // 2 november, 10 okt
  const bulanAlt = Object.keys(BULAN).sort((a, b) => b.length - a.length).join('|');
  if ((m = t.match(new RegExp(`\\b(\\d{1,2})\\s*(${bulanAlt})\\b`)))) {
    const day = Number(m[1]);
    const month = BULAN[m[2]!]!;
    let year = today.year;
    if (isBefore({ year, month, day }, today)) year += 1;
    return { year, month, day };
  }

  // tgl 30, tanggal 5
  if ((m = t.match(/\b(?:tgl|tanggal)\.?\s*(\d{1,2})\b/))) {
    const day = Number(m[1]);
    let ref: DayRef = { year: today.year, month: today.month, day };
    if (isBefore(ref, today)) ref = { year: today.year, month: today.month + 1, day };
    return addDays(ref, 0);
  }

  if ((m = t.match(/\b(\d{1,2})\s*hari\s*lagi\b/))) return addDays(today, Number(m[1]));
  if ((m = t.match(/\b(\d{1,2})\s*minggu\s*lagi\b/))) return addDays(today, 7 * Number(m[1]));
  if (/\b(seminggu\s*lagi|minggu\s*depan)\b/.test(t) && !/\bhari\s+minggu\b/.test(t)) {
    return addDays(today, 7);
  }

  if (/\blusa\b/.test(t)) return addDays(today, 2);
  if (/\bbesok\b/.test(t)) return addDays(today, 1);

  // Nama hari. "minggu" hanya dianggap hari kalau bukan "minggu depan/lagi/ini" atau "seminggu".
  const dayRe = /\b(senin|selasa|rabu|kamis|jumat|sabtu|ahad|minggu)\b(\s+depan)?/g;
  for (const dm of t.matchAll(dayRe)) {
    const name = dm[1]!;
    if (name === 'minggu') {
      const before = t.slice(0, dm.index);
      const after = t.slice(dm.index! + dm[0].length);
      const isHari = /hari\s*$/.test(before);
      if (!isHari && (/\d\s*$/.test(before) || /^\s*(lagi|ini)\b/.test(after))) continue;
    }
    const target = HARI[name]!;
    if (dm[2]) return addDays(today, 7 - mondayIdx + target);
    return addDays(today, (target - mondayIdx + 7) % 7);
  }

  if (/\b(hari\s*ini|nanti|ntar|malam\s*ini|sore\s*ini|siang\s*ini|pagi\s*ini)\b/.test(t)) return today;
  return null;
}

interface TimeOfDay {
  hour: number;
  minute: number;
  /** "jam 8" tanpa pagi/malam: bisa 08.00 atau 20.00. */
  ambiguous: boolean;
}

function findTime(t: string): TimeOfDay | null {
  const m = t.match(/\b(?:jam|pukul|pkl)\.?\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(pagi|siang|sore|malam))?/);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const period = m[3] ?? t.match(/\b(pagi|siang|sore|malam)\b/)?.[1];
    if ((period === 'sore' || period === 'malam') && hour < 12) hour += 12;
    if (period === 'siang' && hour < 6) hour += 12;
    if (hour <= 23 && minute <= 59) return { hour, minute, ambiguous: !period && hour >= 1 && hour <= 12 };
  }
  const pm = t.match(/\b(pagi|siang|sore|malam)\b/);
  if (pm) return { hour: PERIOD_HOUR[pm[1]!]!, minute: 0, ambiguous: false };
  return null;
}

/** Jam tanpa tanggal: kemunculan terdekat setelah `now` ("jam 8" pukul 19.04 → 20.00 hari ini). */
function nextOccurrence(time: TimeOfDay, today: DayRef, now: Date): Date {
  const hours = time.ambiguous ? [time.hour % 12, (time.hour % 12) + 12] : [time.hour];
  const candidates = [0, 1].flatMap((d) => {
    const day = addDays(today, d);
    return hours.map((h) => fromWIB(day.year, day.month, day.day, h, time.minute));
  });
  return candidates.filter((c) => c > now).sort((a, b) => a.getTime() - b.getTime())[0]!;
}

/**
 * Ubah ungkapan waktu bahasa Indonesia ("Jumat", "besok sore", "tgl 30", "minggu depan")
 * menjadi Date, relatif terhadap `now`, di zona Asia/Jakarta. null kalau tidak ada tanggal.
 */
export function parseRelativeDate(input: string, now: Date): ParsedDate | null {
  const t = input
    .toLowerCase()
    .replace(/[’'`]/g, '')
    // Kosakata waktu Jawa → padanan Indonesia
    .replace(/\bsesuk\b/g, 'besok')
    .replace(/\bmengko\b/g, 'nanti')
    .replace(/\bbengi\b/g, 'malam')
    .replace(/\besuk\b/g, 'pagi')
    .replace(/\s+/g, ' ');
  const w = wibParts(now);
  const today: DayRef = { year: w.year, month: w.month, day: w.day };
  const mondayIdx = (w.weekday + 6) % 7;

  const time = findTime(t);
  const day = findDay(t, today, mondayIdx);
  // Jam disebut tanpa tanggal ("jam 8", "nanti jam 9 malam") → kemunculan terdekat ke depan.
  const vagueDay = !day || (/\b(nanti|ntar|hari\s*ini|malam\s*ini|sore\s*ini|siang\s*ini|pagi\s*ini)\b/.test(t) && sameDay(day, today));
  if (time && vagueDay && /\b(?:jam|pukul|pkl)\b/.test(t)) return { date: nextOccurrence(time, today, now), hasTime: true };
  if (!day) return null;

  const { hour, minute } = time ?? { hour: DEFAULT_HOUR, minute: 0 };
  return { date: fromWIB(day.year, day.month, day.day, hour, minute), hasTime: time !== null };
}
