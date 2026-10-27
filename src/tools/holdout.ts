// Alat holdout: mengubah ekspor chat WhatsApp asli (dengan persetujuan) menjadi set berlabel yang
// TIDAK pernah dipakai untuk menyetel prompt/prefilter, lalu mengukur precision/recall deteksi janji.
// Lihat docs/PILOT.md bagian "Mengukur deteksi janji secara jujur".

export interface ChatLine {
  /** Waktu seperti tertulis di ekspor, dinormalkan ke ISO kalau bisa dibaca. */
  at: string | null;
  author: string;
  text: string;
  media: boolean;
}

export interface Label {
  promise: boolean | null;
  /** 'self' = penulis sendiri, 'other' = menunjuk orang lain. */
  owner: 'self' | 'other' | null;
  /** Ungkapan waktu persis seperti di pesan ("jumat", "besok sore"), null kalau tidak ada. */
  deadline: string | null;
}

export interface HoldoutItem {
  id: number;
  at: string | null;
  author: string;
  text: string;
  label: Label;
}

const INVISIBLE = /[\u200e\u200f\u202a-\u202e\ufeff]/g;
// Android: "23/10/26 19.05 - Nama: pesan" (juga "23/10/2026, 19:05"); iOS: "[23/10/26 19.05.12] Nama: pesan"
const ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2})[.:](\d{2})(?:[.:]\d{2})?\s*(?:[AP]M)?\s+-\s+(.*)$/i;
const IOS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2})[.:](\d{2})(?:[.:]\d{2})?\s*(?:[AP]M)?\]\s+(.*)$/i;
const MEDIA = /^<?(media tidak disertakan|media omitted|gambar tidak disertakan|image omitted|video omitted|sticker omitted|stiker tidak disertakan)>?$/i;

function isoOf(d: string, m: string, y: string, hh: string, mm: string): string | null {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const date = new Date(Date.UTC(year, Number(m) - 1, Number(d), Number(hh) - 7, Number(mm)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Baca file "Ekspor chat" WhatsApp (.txt). Pesan multi-baris digabung; pesan sistem dilewati. */
export function parseWhatsAppExport(raw: string): ChatLine[] {
  const out: ChatLine[] = [];
  let current: ChatLine | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(INVISIBLE, '');
    const m = line.match(ANDROID) ?? line.match(IOS);
    if (m) {
      const [, d, mo, y, hh, mm, rest] = m;
      const sep = rest!.indexOf(': ');
      if (sep < 0) {
        current = null; // pesan sistem ("X menambahkan Y", "Pesan dienkripsi…")
        continue;
      }
      const text = rest!.slice(sep + 2).trim();
      current = { at: isoOf(d!, mo!, y!, hh!, mm!), author: rest!.slice(0, sep).trim(), text, media: MEDIA.test(text) };
      out.push(current);
    } else if (current && line.trim()) {
      current.text += `\n${line}`;
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ganti nama penulis dengan Siswa1, Siswa2, … (juga di dalam teks), serta nomor HP & email.
 * Pemetaan nama TIDAK dikembalikan supaya tidak ikut tersimpan.
 */
export function anonymize(lines: ChatLine[]): ChatLine[] {
  const alias = new Map<string, string>();
  for (const l of lines) if (!alias.has(l.author)) alias.set(l.author, `Siswa${alias.size + 1}`);
  // Nama lengkap dulu, lalu nama depan (≥ 3 huruf) — "Budi Santoso" dan "budi" sama-sama tersamar.
  const swaps: [RegExp, string][] = [];
  for (const [name, a] of [...alias].sort((x, y) => y[0].length - x[0].length)) {
    swaps.push([new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu'), a]);
    const first = name.split(/\s+/)[0]!;
    if (first.length >= 3 && first !== name && !/^\+?\d/.test(first)) swaps.push([new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(first)}(?![\\p{L}\\p{N}])`, 'giu'), a]);
  }
  const scrub = (t: string) => {
    let s = t
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
      .replace(/@\d{6,}/g, '@[nomor]')
      .replace(/(?:\+62|62|0)8[\d\s-]{7,13}\d/g, '[nomor]');
    for (const [re, a] of swaps) s = s.replace(re, a);
    return s;
  };
  return lines.map((l) => ({ ...l, author: alias.get(l.author)!, text: scrub(l.text) }));
}

export function toHoldout(lines: ChatLine[]): HoldoutItem[] {
  return lines
    .filter((l) => !l.media && l.text.trim())
    .map((l, i) => ({ id: i + 1, at: l.at, author: l.author, text: l.text, label: { promise: null, owner: null, deadline: null } }));
}

export interface Prediction {
  id: number;
  passedPrefilter: boolean;
  predicted: boolean;
  deadlineMatches?: boolean | null;
}

export interface EvalReport {
  labeled: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Janji asli yang tidak lolos prefilter (hilang permanen). */
  missedByPrefilter: number[];
  /** Janji asli yang lolos prefilter tapi ditolak LLM. */
  missedByLlm: number[];
  falsePositives: number[];
  /** Dari janji yang terdeteksi benar & punya deadline berlabel: berapa yang tanggalnya tepat. */
  deadline: { checked: number; correct: number };
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);

export function evaluate(items: HoldoutItem[], preds: Prediction[]): EvalReport {
  const byId = new Map(preds.map((p) => [p.id, p]));
  const r: EvalReport = { labeled: 0, tp: 0, fp: 0, fn: 0, tn: 0, precision: null, recall: null, f1: null, missedByPrefilter: [], missedByLlm: [], falsePositives: [], deadline: { checked: 0, correct: 0 } };
  for (const it of items) {
    if (it.label.promise === null) continue;
    const p = byId.get(it.id);
    if (!p) continue;
    r.labeled++;
    if (it.label.promise && p.predicted) {
      r.tp++;
      if (p.deadlineMatches !== undefined && p.deadlineMatches !== null) {
        r.deadline.checked++;
        if (p.deadlineMatches) r.deadline.correct++;
      }
    } else if (it.label.promise && !p.predicted) {
      r.fn++;
      (p.passedPrefilter ? r.missedByLlm : r.missedByPrefilter).push(it.id);
    } else if (!it.label.promise && p.predicted) {
      r.fp++;
      r.falsePositives.push(it.id);
    } else r.tn++;
  }
  r.precision = ratio(r.tp, r.tp + r.fp);
  r.recall = ratio(r.tp, r.tp + r.fn);
  r.f1 = r.precision !== null && r.recall !== null && r.precision + r.recall > 0 ? Math.round(((2 * r.precision * r.recall) / (r.precision + r.recall)) * 1000) / 1000 : null;
  return r;
}
