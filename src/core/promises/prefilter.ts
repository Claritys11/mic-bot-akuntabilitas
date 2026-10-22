// Filter murah sebelum LLM (prinsip "Hemat LLM"). Hanya pesan yang lolos yang dikirim ke LLM.

const OWNER_RE = /\b(aku|saya|gue|gw|gua|aq|ak|tak|kula)\s+(yang|yg|aja|ajah|deh)\b|\bbiar\s+(aku|saya|gue|gw)\b|\bnanti\s+(aku|saya|gue|gw)\b|\b(siap|oke|ok)\s+(aku|saya|gue|gw)\b/i;
const COMMIT_RE = /\b(jadi|deadline|dl|besok|lusa|nanti|ntar|minggu\s+depan|tgl|tanggal|senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad|selesai|kelar|beres|kumpul|transfer|bayar)\b|\b\d{1,2}[/-]\d{1,2}\b/i;
const KAS_RE = /\b(transfer|tf|bayar|kas|iuran|lunas)\b/i;

/** Kalimat yang mungkin janji: ada penanda pemilik ("aku yang") atau penanda waktu + kata kerja tugas. */
export function looksLikePromise(text: string): boolean {
  if (!text || text.length < 6 || text.length > 500) return false;
  if (OWNER_RE.test(text)) return COMMIT_RE.test(text) || text.split(/\s+/).length >= 4;
  // "@budi yang bikin poster, Jumat" — penugasan ke orang lain
  return /@\S+\s+(yang|yg)\b/i.test(text) && COMMIT_RE.test(text);
}

export function looksLikeKas(text: string): boolean {
  return KAS_RE.test(text);
}

export interface Extraction {
  isPromise: boolean;
  task: string;
  /** Nama pemilik kalau bukan penulis pesan (mis. "@budi yang bikin"). */
  ownerName?: string;
  deadlineText?: string;
  confidence: number;
}

const TIME_WORDS =
  /\b(?:(?:hari\s+)?(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)(?:\s+depan)?|besok(?:\s+(?:pagi|siang|sore|malam))?|lusa|nanti\s+(?:pagi|siang|sore|malam)|minggu\s+depan|(?:tgl|tanggal)\.?\s*\d{1,2}|\d{1,2}[/-]\d{1,2}|\d{1,2}\s+hari\s+lagi|(?:jam|pukul)\s*\d{1,2}(?:[:.]\d{2})?(?:\s*(?:pagi|siang|sore|malam))?)\b/gi;

/**
 * Ekstraksi cadangan tanpa LLM (dipakai kalau LLM tidak dikonfigurasi / gagal).
 * Sengaja sederhana: "aku yang <tugas> [ya], <waktu> [jadi]".
 */
export function heuristicExtract(text: string): Extraction | null {
  const m = text.match(/\b(?:aku|saya|gue|gw|gua|aq|biar\s+(?:aku|saya|gue|gw))\s+(?:aja\s+)?(?:yang|yg)?\s*(.+)/i);
  if (!m || !OWNER_RE.test(text)) return null;
  const times = text.match(TIME_WORDS) ?? [];
  let task = m[1]!.replace(TIME_WORDS, ' ');
  task = task
    .split(/[,.!?]/)[0]!
    .replace(/\b(ya|yah|yaa|deh|dong|aja|jadi|kok|nanti|ntar|deadline)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (task.split(' ').length < 1 || task.length < 3) return null;
  return {
    isPromise: true,
    task,
    deadlineText: times.length ? times.join(' ') : undefined,
    confidence: 0.6,
  };
}
