// Janji langsung aktif tanpa klik konfirmasi — karena yang paling sering ingkar justru yang paling
// jarang mengklik ✅ (temuan review). Dibatasi ketat supaya bot tidak "menuduh" orang berjanji.

export const AUTO_MIN_CONFIDENCE = 0.8;

export interface AutoInput {
  /** Diekstrak LLM (bukan heuristik cadangan): dua penilai — prefilter & LLM — sama-sama setuju. */
  source: 'llm' | 'heuristic';
  confidence: number;
  /** Penulis pesan = pemilik janji. Menunjuk orang lain ("@Budi yang bikin") tetap perlu konfirmasi Budi. */
  ownerIsAuthor: boolean;
  /** Deadline terbaca. Tanpa deadline tidak ada yang bisa ditagih → tanya dulu. */
  hasDeadline: boolean;
}

export function shouldAutoActivate(i: AutoInput): boolean {
  return i.source === 'llm' && i.ownerIsAuthor && i.hasDeadline && i.confidence >= AUTO_MIN_CONFIDENCE;
}

const STOP = new Set(['ya', 'yah', 'deh', 'dong', 'aja', 'kok', 'nih', 'sih', 'yang', 'yg', 'nya', 'buat', 'untuk', 'the', 'dan']);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );

/** "bikin PPT" ≈ "bikin ppt presentasi" → janji yang diulang tidak dicatat dua kali. */
export function similarTask(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const small = Math.min(x.size, y.size);
  return both / small >= 0.75 || both / (x.size + y.size - both) >= 0.5;
}
