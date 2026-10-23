import { isLight, tidyReply, type Mood } from '../chat/mood.ts';
import type { SpeechLevel } from '../types.ts';

// Suara bot saat nimbrung soal janji: kalimat obrolan biasa, bukan kartu formal.
// Dua nada per tingkat tutur: "ceria" (suasana santai) dan "netral" (serius/tegang/sedih),
// beberapa variasi masing-masing supaya tidak terdengar seperti mesin.

type Pick = () => number;
const choose = <T>(xs: readonly T[], pick: Pick): T => xs[Math.floor(pick() * xs.length) % xs.length]!;
type Tone = 'ceria' | 'netral';
const toneOf = (mood: Mood): Tone => (isLight(mood) ? 'ceria' : 'netral');

/** Token yang diminta ke LLM untuk menyebut pemilik janji; diganti mention oleh core. */
export const OWNER_TOKEN = '@PEMILIK';

type AskFn = (who: string, task: string) => string;
const ASK: Record<SpeechLevel, Record<Tone, readonly AskFn[]>> = {
  santai: {
    ceria: [
      (who) => `jadi gak ${who}? kalau jadi langsung ku catat nih hahaha`,
      (who, task) => `wih ${who} gercep 👀 ${task} beneran ya? klik jadi biar ku catat`,
      (who) => `oke ${who}, ini serius kan? kalau iya ku catat biar nanti ku ingetin 😆`,
      (who, task) => `${task} aman di ${who} nih? konfirmasi dulu dong, nanti ku tagih lho hehe`,
    ],
    netral: [
      (who, task) => `oke ${who}, ${task} jadi ya? kalau iya ku catat biar nanti ku ingetin`,
      (who) => `noted ${who}. konfirmasi aja kalau jadi, nanti ku catat`,
      (who, task) => `${task} di ${who} ya? klik jadi biar ga kelewat`,
    ],
  },
  sopan: {
    ceria: [
      (who) => `${who}, jadi ya? Kalau jadi, saya catat supaya nanti bisa saya ingatkan 🙂`,
      (who, task) => `Siap, ${who}. ${task} jadi dikerjakan? Konfirmasi dulu ya, nanti saya bantu ingatkan.`,
    ],
    netral: [
      (who, task) => `${who}, ${task} jadi dikerjakan? Kalau iya, saya catat supaya bisa saya ingatkan.`,
      (who) => `Baik ${who}. Mohon dikonfirmasi kalau jadi, nanti saya catat.`,
    ],
  },
  krama: {
    ceria: [
      (who) => `${who}, saestu badhe dipuntindakaken? Menawi saestu, kula cathet supados saged kula engetaken 🙏`,
      (who, task) => `Nuwun sewu ${who}, ${task} saestu? Nyuwun dipunkonfirmasi rumiyin nggih 🙏`,
    ],
    netral: [(who, task) => `Nuwun sewu ${who}, ${task} saestu? Menawi inggih, kula cathet.`],
  },
};

type ConfirmFn = (who: string, hasDeadline: boolean) => string;
const CONFIRMED: Record<SpeechLevel, Record<Tone, readonly ConfirmFn[]>> = {
  santai: {
    ceria: [
      (who, d) => (d ? `sip ${who}, udah ku catat ✍️ nanti ku colek pas mepet deadline ya` : `sip ${who}, ku catat ✍️ tapi belum ada deadline-nya, klik ✏️ kalau mau ku ingetin`),
      (who, d) => (d ? `mantap ${who} 🔥 tercatat! jangan kabur ya hahaha` : `oke ${who}, tercatat. deadline-nya kapan? klik ✏️ biar ku ingetin`),
    ],
    netral: [
      (who, d) => (d ? `oke ${who}, udah ku catat. nanti ku ingetin sebelum deadline` : `oke ${who}, udah ku catat. belum ada deadline-nya, klik ✏️ kalau mau ku ingetin`),
    ],
  },
  sopan: {
    ceria: [
      (who, d) => (d ? `Baik ${who}, sudah saya catat. Nanti saya ingatkan menjelang deadline 🙂` : `Baik ${who}, sudah saya catat. Belum ada deadline — klik ✏️ untuk menambahkan.`),
    ],
    netral: [
      (who, d) => (d ? `Baik ${who}, sudah saya catat. Nanti saya ingatkan menjelang deadline.` : `Baik ${who}, sudah saya catat. Belum ada deadline — klik ✏️ untuk menambahkan.`),
    ],
  },
  krama: {
    ceria: [(who, d) => (d ? `Sendika ${who}, sampun kula cathet. Mangke kula engetaken 🙏` : `Sendika ${who}, sampun kula cathet. Dereng wonten deadline, mangga klik ✏️.`)],
    netral: [(who, d) => (d ? `Sendika ${who}, sampun kula cathet. Mangke kula engetaken.` : `Sendika ${who}, sampun kula cathet. Dereng wonten deadline, mangga klik ✏️.`)],
  },
};

const CANCELLED: Record<SpeechLevel, Record<Tone, readonly string[]>> = {
  santai: { ceria: ['oke deh, ga jadi ku catat 👌', 'siap, anggap aja aku salah denger hehe 🙈'], netral: ['oke, ga ku catat'] },
  sopan: { ceria: ['Baik, tidak saya catat 👌'], netral: ['Baik, tidak saya catat.'] },
  krama: { ceria: ['Inggih, mboten kula cathet 🙏'], netral: ['Inggih, mboten kula cathet.'] },
};

const DONE: Record<SpeechLevel, Record<Tone, { onTime: string; late: string }>> = {
  santai: {
    ceria: { onTime: 'GG! kelar tepat waktu 🎉 makasih banyak ya', late: 'akhirnya kelar juga 😮‍💨 telat dikit gapapa, makasih ya!' },
    netral: { onTime: 'kelar tepat waktu, makasih banyak ya 🙏', late: 'udah kelar, makasih ya. next time semoga bisa lebih awal 🙏' },
  },
  sopan: {
    ceria: { onTime: 'Selesai tepat waktu 🎉 Terima kasih!', late: 'Sudah selesai, meski terlambat. Tetap terima kasih 🙏' },
    netral: { onTime: 'Selesai tepat waktu. Terima kasih 🙏', late: 'Sudah selesai, meski terlambat. Terima kasih 🙏' },
  },
  krama: {
    ceria: { onTime: 'Sampun rampung pas wekdalipun 🎉 Matur nuwun!', late: 'Sampun rampung, senajan rada telat. Matur nuwun 🙏' },
    netral: { onTime: 'Sampun rampung pas wekdalipun. Matur nuwun 🙏', late: 'Sampun rampung, senajan rada telat. Matur nuwun 🙏' },
  },
};

export const LABELS: Record<SpeechLevel, { confirm: string; edit: string; cancel: string; done: string }> = {
  santai: { confirm: '✅ Jadi, catat!', edit: '✏️ Ubah', cancel: '❌ Ga jadi', done: '✅ Udah kelar' },
  sopan: { confirm: '✅ Ya, catat', edit: '✏️ Ubah', cancel: '❌ Bukan janji', done: '✅ Sudah selesai' },
  krama: { confirm: '✅ Inggih, cathet', edit: '✏️ Ubah', cancel: '❌ Sanes janji', done: '✅ Sampun rampung' },
};

export const askLine = (level: SpeechLevel, who: string, task: string, mood: Mood = 'santai', pick: Pick = Math.random) =>
  choose(ASK[level][toneOf(mood)], pick)(who, task);
export const confirmedLine = (level: SpeechLevel, who: string, hasDeadline: boolean, mood: Mood = 'santai', pick: Pick = Math.random) =>
  choose(CONFIRMED[level][toneOf(mood)], pick)(who, hasDeadline);
export const cancelledLine = (level: SpeechLevel, mood: Mood = 'santai', pick: Pick = Math.random) => choose(CANCELLED[level][toneOf(mood)], pick);
export const doneLine = (level: SpeechLevel, late: boolean, mood: Mood = 'santai') => DONE[level][toneOf(mood)][late ? 'late' : 'onTime'];

/**
 * Pakai kalimat buatan LLM kalau aman: pendek, menyebut pemilik lewat token, tanpa link /
 * mention massal; lalu rapikan sesuai suasana. Selain itu null → core jatuh ke template.
 */
export function acceptLlmLine(line: string | null | undefined, who: string, mood: Mood = 'santai', names: string[] = []): string | null {
  if (!line) return null;
  let t = line.replace(/\s+/g, ' ').trim();
  if (t.length < 8 || t.length > 200) return null;
  if (/https?:|www\.|@everyone|@here|<[@#]/i.test(t)) return null;
  if (t.includes(OWNER_TOKEN)) t = t.split(OWNER_TOKEN).join(who);
  else {
    // Model sering menulis "@Ani" langsung alih-alih token — terima selama itu nama yang kita kenal.
    const name = names.find((n) => n && t.toLowerCase().includes(`@${n.toLowerCase()}`));
    if (!name) return null;
    const at = t.toLowerCase().indexOf(`@${name.toLowerCase()}`);
    t = t.slice(0, at) + who + t.slice(at + name.length + 1);
  }
  const out = tidyReply(t, mood);
  return out.length >= 4 ? out : null;
}
