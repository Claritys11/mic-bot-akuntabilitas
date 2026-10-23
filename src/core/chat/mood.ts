// Membaca suasana obrolan supaya bot tidak bercanda saat orang sedang serius / sedih.
// Heuristik murah (tanpa LLM); hasilnya juga dikirim ke LLM sebagai petunjuk, dan dipakai
// sebagai pagar terakhir (`tidyReply`) kalau LLM tetap kelepasan tertawa.

export type Mood = 'santai' | 'serius' | 'tegang' | 'sedih';

const SIGNALS: { mood: Exclude<Mood, 'santai'> | 'santai'; re: RegExp; weight: number }[] = [
  {
    mood: 'sedih',
    re: /\b(sedih|nangis|menangis|duka|berduka|meninggal|wafat|innalillahi|inna lillahi|rip|sakit|opname|rumah sakit|kecelakaan|musibah|kehilangan|lagi down|stres|stress|depresi|capek banget|cape banget|putus asa)\b|😢|😭|🥺|💔|🙏🏻/i,
    weight: 3,
  },
  {
    mood: 'tegang',
    re: /\b(marah|kesel|kesal|bete|emosi|anjir|anjing|bangsat|parah|gimana sih|kok gitu|jangan bercanda|ga lucu|gak lucu|nggak lucu|telat lagi|lagi-lagi|ribut|berantem|salah siapa|nyalahin)\b|😡|🤬|😤|!{3,}/i,
    weight: 3,
  },
  {
    mood: 'serius',
    re: /\b(ujian|ulangan|uts|uas|pts|asesmen|ukk|remed|remedial|nilai|rapor|raport|guru|bu guru|pak guru|wali kelas|walas|kepsek|rapat|penting|urgent|darurat|tolong|mohon|segera|serius|deadline hari ini|dikumpulin hari ini|sidang)\b/i,
    weight: 2,
  },
  { mood: 'santai', re: /\b(wkwk\w*|haha\w*|hehe\w*|xixi\w*|lol|lmao|anjay|gas|gaskeun|santuy|mantap|mantul|asik|asyik|ngakak|bjir|bjirr)\b|😂|🤣|😆|😹|😜/i, weight: 2 },
];

/** Kalimat yang hampir semua huruf kapital = teriakan (singkatan seperti "PPT"/"RPL" tidak terhitung). */
function isShouting(t: string): boolean {
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return false;
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
}

const RANK: Record<Mood, number> = { santai: 0, serius: 1, tegang: 2, sedih: 3 };

/**
 * Suasana dari beberapa pesan terakhir (urut lama → baru). Pesan terbaru paling berpengaruh.
 * Tanpa sinyal apa pun → 'santai' (obrolan kelas sehari-hari), tapi bot tetap sopan.
 */
export function detectMood(texts: string[]): Mood {
  const recent = texts.slice(-8);
  const score: Record<Mood, number> = { santai: 0, serius: 0, tegang: 0, sedih: 0 };
  recent.forEach((t, i) => {
    const w = 1 + i / Math.max(recent.length - 1, 1); // 1 (terlama) … 2 (terbaru)
    for (const s of SIGNALS) if (s.re.test(t)) score[s.mood] += s.weight * w;
    if (isShouting(t)) score.tegang += 2 * w;
  });
  // Suasana berat menang atas tawa: satu kabar duka tidak hilang karena ada yang "wkwk".
  const heavy = (['sedih', 'tegang', 'serius'] as const).filter((m) => score[m] >= 2).sort((a, b) => score[b] - score[a])[0];
  if (heavy && score[heavy] >= score.santai * 0.6) return heavy;
  return 'santai';
}

/** Gabungan dua penilaian (heuristik & LLM): ambil yang lebih serius — lebih aman salah serius daripada salah bercanda. */
export function graverMood(a: Mood, b: Mood | null | undefined): Mood {
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

const LAUGH = /\s*\b(?:wkwk\w*|haha\w*|hehe\w*|xixi\w*|lol|lmao|ngakak)\b[.!]*/gi;
const PLAYFUL_EMOJI = /\s*(?:😂|🤣|😆|😹|😜|😝|🤪|😁|😄|😎|🔥|👀|🤭)/gu;

/** Pagar terakhir: kalau suasana tidak santai, buang tawa & emoji usil dari balasan. */
export function tidyReply(text: string, mood: Mood): string {
  if (mood === 'santai') return text.trim();
  return text
    .replace(LAUGH, '')
    .replace(PLAYFUL_EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([?.!,])/g, '$1')
    .trim();
}

export const isLight = (m: Mood) => m === 'santai';
