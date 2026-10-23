import type { SpeechLevel } from '../types.ts';

// Suara bot saat nimbrung soal janji: kalimat obrolan biasa, bukan kartu formal.
// Beberapa variasi per tingkat tutur supaya tidak terdengar seperti mesin.

type Pick = () => number;
const choose = <T>(xs: readonly T[], pick: Pick): T => xs[Math.floor(pick() * xs.length) % xs.length]!;

/** Token yang diminta ke LLM untuk menyebut pemilik janji; diganti mention oleh core. */
export const OWNER_TOKEN = '@PEMILIK';

const ASK: Record<SpeechLevel, readonly ((who: string, task: string) => string)[]> = {
  santai: [
    (who) => `jadi gak ${who}? kalau jadi langsung ku catat nih hahaha`,
    (who, task) => `wih ${who} gercep 👀 ${task} beneran ya? klik jadi biar ku catat`,
    (who) => `oke ${who}, ini serius kan? kalau iya ku catat biar nanti ku ingetin 😆`,
    (who, task) => `${task} aman di ${who} nih? konfirmasi dulu dong, nanti ku tagih lho hehe`,
  ],
  sopan: [
    (who) => `${who}, jadi ya? Kalau jadi, saya catat supaya nanti bisa saya ingatkan 🙂`,
    (who, task) => `Siap, ${who}. ${task} jadi dikerjakan? Konfirmasi dulu ya, nanti saya bantu ingatkan.`,
  ],
  krama: [
    (who) => `${who}, saestu badhe dipuntindakaken? Menawi saestu, kula cathet supados saged kula engetaken 🙏`,
    (who, task) => `Nuwun sewu ${who}, ${task} saestu? Nyuwun dipunkonfirmasi rumiyin nggih 🙏`,
  ],
};

const CONFIRMED: Record<SpeechLevel, readonly ((who: string, hasDeadline: boolean) => string)[]> = {
  santai: [
    (who, d) => (d ? `sip ${who}, udah ku catat ✍️ nanti ku colek pas mepet deadline ya` : `sip ${who}, ku catat ✍️ tapi belum ada deadline-nya, klik ✏️ kalau mau ku ingetin`),
    (who, d) => (d ? `mantap ${who} 🔥 tercatat! jangan kabur ya hahaha` : `oke ${who}, tercatat. deadline-nya kapan? klik ✏️ biar ku ingetin`),
  ],
  sopan: [
    (who, d) => (d ? `Baik ${who}, sudah saya catat. Nanti saya ingatkan menjelang deadline 🙂` : `Baik ${who}, sudah saya catat. Belum ada deadline — klik ✏️ untuk menambahkan.`),
  ],
  krama: [
    (who, d) => (d ? `Sendika ${who}, sampun kula cathet. Mangke kula engetaken 🙏` : `Sendika ${who}, sampun kula cathet. Dereng wonten deadline, mangga klik ✏️.`),
  ],
};

const CANCELLED: Record<SpeechLevel, readonly string[]> = {
  santai: ['oke deh, ga jadi ku catat 👌', 'siap, anggap aja aku salah denger hehe 🙈'],
  sopan: ['Baik, tidak saya catat 👌'],
  krama: ['Inggih, mboten kula cathet 🙏'],
};

const DONE: Record<SpeechLevel, { onTime: string; late: string }> = {
  santai: { onTime: 'GG! kelar tepat waktu 🎉 makasih banyak ya', late: 'akhirnya kelar juga 😮‍💨 telat dikit gapapa, makasih ya!' },
  sopan: { onTime: 'Selesai tepat waktu 🎉 Terima kasih!', late: 'Sudah selesai, meski terlambat. Tetap terima kasih 🙏' },
  krama: { onTime: 'Sampun rampung pas wekdalipun 🎉 Matur nuwun!', late: 'Sampun rampung, senajan rada telat. Matur nuwun 🙏' },
};

export const LABELS: Record<SpeechLevel, { confirm: string; edit: string; cancel: string; done: string }> = {
  santai: { confirm: '✅ Jadi, catat!', edit: '✏️ Ubah', cancel: '❌ Ga jadi', done: '✅ Udah kelar' },
  sopan: { confirm: '✅ Ya, catat', edit: '✏️ Ubah', cancel: '❌ Bukan janji', done: '✅ Sudah selesai' },
  krama: { confirm: '✅ Inggih, cathet', edit: '✏️ Ubah', cancel: '❌ Sanes janji', done: '✅ Sampun rampung' },
};

export const askLine = (level: SpeechLevel, who: string, task: string, pick: Pick = Math.random) => choose(ASK[level], pick)(who, task);
export const confirmedLine = (level: SpeechLevel, who: string, hasDeadline: boolean, pick: Pick = Math.random) =>
  choose(CONFIRMED[level], pick)(who, hasDeadline);
export const cancelledLine = (level: SpeechLevel, pick: Pick = Math.random) => choose(CANCELLED[level], pick);
export const doneLine = (level: SpeechLevel, late: boolean) => (late ? DONE[level].late : DONE[level].onTime);

/**
 * Pakai kalimat buatan LLM kalau aman: satu baris, pendek, menyebut pemilik lewat token,
 * tanpa link / mention massal. Selain itu null → core jatuh ke template.
 */
export function acceptLlmLine(line: string | null | undefined, who: string): string | null {
  if (!line) return null;
  const t = line.replace(/\s+/g, ' ').trim();
  if (t.length < 8 || t.length > 200 || !t.includes(OWNER_TOKEN)) return null;
  if (/https?:|www\.|@everyone|@here|<[@#]/i.test(t)) return null;
  return t.split(OWNER_TOKEN).join(who);
}
