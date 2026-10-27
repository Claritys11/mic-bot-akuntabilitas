// Filter murah sebelum LLM (prinsip "Hemat LLM"). Hanya pesan yang lolos yang dikirim ke LLM.

// Kata ganti orang pertama (Indonesia, slang, Jawa). "tak"/"ku" hanya dihitung bila langsung diikuti
// kata kerja ("tak garapne", "ku kerjain") — "tak bisa" / "tak tahu" berarti "tidak".
const PRON = String.raw`(?:aku|saya|sy|gue|gw|gua|aq|ak|ane|kula)`;
const VERB = String.raw`(?:bikin\w*|buat\w*|kerja\w*|garap\w*|handle|urus\w*|ambil|pegang|kirim\w*|print|ngeprint|cetak|rangkum\w*|beli\w*|bawa\w*|siap(?:in|kan)|beres(?:in)?|selesai(?:in|kan)|hubungi|kumpul(?:in|kan)|presentasi\w*|n?gawe|damel|tulis\w*|ketik\w*|edit\w*|desain\w*|rekap\w*|catat\w*|transfer\w*|bayar\w*|jemput\w*|pinjam\w*|pinjem\w*|cek\w*|tanya\w*|bantu\w*|fotokopi\w*|upload\w*|share\w*)`;
const OWNER_RE = new RegExp(
  [
    String.raw`\b${PRON}\s+(?:yang|yg|sing|ingkang|aja|ajah|deh)\b`, // aku yang / sy yg / aku sing
    String.raw`\bbiar\s+${PRON}\b`, // biar aku
    String.raw`\b(?:nanti|ntar|ntr|mengko|sesuk|besok)\s+(?:${PRON}|tak|ku)\b`, // nanti tak kirim
    String.raw`\b(?:siap|oke|okee|ok|sip|yaudah|yowes)\W+${PRON}\b`, // siap, aku …
    String.raw`\b(?:${PRON}\s+|tak\s+|ku\s?)${VERB}\b`, // aku handle / tak garapne / kukerjain
  ].join('|'),
  'i',
);
const COMMIT_RE =
  /\b(jadi|deadline|dl|besok|lusa|nanti|ntar|mengko|sesuk|bengi|sekarang|maks|minggu\s+depan|malam\s+ini|tgl|tanggal|jam\s*\d|senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad|selesai|kelar|beres|kumpul|transfer|bayar)\b|\b\d{1,2}[/-]\d{1,2}\b/i;
// Cerita lampau ("kemarin aku yang bikin ppt") bukan janji — kecuali ada penanda waktu ke depan juga.
const PAST_RE = /\b(kemarin|kemaren|kmrn|tadi|barusan|wingi|(?:minggu|bulan|tahun)\s+lalu)\b/i;
const FUTURE_RE = /\b(besok|lusa|nanti|ntar|mengko|sesuk|minggu\s+depan|malam\s+ini|jam\s*\d)\b/i;
const KAS_RE = /\b(transfer|tf|bayar|kas|iuran|lunas)\b/i;

/** Kalimat yang mungkin janji: ada penanda pemilik ("aku yang", "tak garapne") + penanda waktu/tugas. */
export function looksLikePromise(text: string): boolean {
  if (!text || text.length < 6 || text.length > 500) return false;
  if (PAST_RE.test(text) && !FUTURE_RE.test(text)) return false;
  if (OWNER_RE.test(text)) return COMMIT_RE.test(text) || text.split(/\s+/).length >= 4;
  // "@budi yang bikin poster, Jumat" — penugasan ke orang lain
  return /@\S+\s+(yang|yg|sing)\b/i.test(text) && COMMIT_RE.test(text);
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
  /** Kalimat balasan buatan LLM (pakai token @PEMILIK); heuristik tidak mengisinya. */
  reply?: string;
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
