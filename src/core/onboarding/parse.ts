import type { KasPeriod } from '../kas/ledger.ts';

// Pengurai jawaban wawancara setup. Jawaban ditulis santai, jadi buang basa-basi dulu.

const FILLER = /\b(kelas(?:nya)?|kita|kami|aku|saya|jurusan(?:nya)?|ada|itu|kak|bang|bro|sih|dong|ya|yaa)\b/gi;

export function parseClassName(text: string): string | null {
  const name = text.replace(FILLER, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name.length >= 2 ? name : null;
}

export function parseMajors(text: string): string[] {
  const parts = text
    .replace(FILLER, ' ')
    .split(/,|\/|&|\+|\bdan\b|\bsama\b|\s+/i)
    .map((p) => p.trim().toUpperCase())
    // Singkatan jurusan SMK: huruf saja, 2–8 karakter (RPL, TKJ, PG, DKV, ANIMASI…).
    .filter((p) => /^[A-Z]{2,8}$/.test(p) && !['DAN', 'SAMA', 'HMM', 'GATAU', 'TAU'].includes(p));
  return [...new Set(parts)];
}

const NO_KAS = /^(?:(?:nggak|ngga|gak|ga|enggak|tidak|nope|belum)\b.*\b(?:ada|kas)\b|nggak|ngga|gak|ga|enggak|tidak|nope)\W*$/i;

export function parseKas(text: string): { amount: number; period: KasPeriod } | 'none' | null {
  const t = text.trim().toLowerCase();
  if (NO_KAS.test(t)) return 'none';
  const m = t.match(/(\d[\d.,]*)\s*(rb|ribu|k|jt|juta)?\b/);
  if (!m) return null;
  const base = Number(m[1]!.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  const mult = m[2] === 'jt' || m[2] === 'juta' ? 1_000_000 : m[2] ? 1000 : 1;
  const amount = Math.round(base * mult);
  if (!amount || amount > 10_000_000) return null;
  const period: KasPeriod = /minggu|pekan/.test(t) ? 'mingguan' : 'bulanan';
  return { amount, period };
}
