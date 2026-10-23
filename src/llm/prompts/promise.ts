import type { ChatMessage } from '../provider.ts';
import { personaRules, type Level, type MoodHint } from './persona.ts';

const EXAMPLES = `Contoh "reply" yang bagus (santai):
- suasana santai, "aku yang bikin PPT ya, jumat jadi" → "jadi gak @PEMILIK? kalau jadi langsung ku catat nih hahaha"
- suasana santai, "biar aku aja yang print, besok" → "wih @PEMILIK gercep. print-nya besok ya? klik jadi biar ku catat"
- suasana serius (bahas ujian), "aku yang rangkum materi bab 3, rabu" → "oke @PEMILIK, rangkuman bab 3 hari Rabu ya. kalau jadi ku catat biar ga kelewat"
- suasana tegang (ada yang kesal tugas belum jalan), "yaudah aku yang kerjain sisanya malam ini" → "noted @PEMILIK, sisanya malam ini ya. klik jadi biar ku catat"
- suasana sedih (ada yang sakit), "aku yang gantiin bagian dia dulu" → "makasih udah mau gantiin, @PEMILIK 🙏 mau ku catat biar ga lupa?"
Contoh JELEK: "Halo! Saya mendeteksi sebuah janji..." (kaku), "wkwk" saat suasana serius, kalimat > 2.`;

export function promisePrompt(input: {
  text: string;
  authorName: string;
  mentionNames: string[];
  nowWIB: string;
  speechLevel: Level;
  /** Suasana menurut heuristik — petunjuk, LLM boleh menilai lebih serius dari konteks. */
  moodHint: MoodHint;
  /** Beberapa pesan sebelumnya di channel ("Nama: teks"), lama → baru. */
  recent: string[];
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `Tugasmu: dari pesan TERAKHIR di obrolan grup kelas SMK (bahasa Indonesia, boleh campur Jawa/slang), tentukan apakah itu janji/komitmen, lalu tulis balasan singkat.
Janji = seseorang menyatakan AKAN mengerjakan tugas tertentu untuk kelompok/kelas ("aku yang bikin PPT", "biar saya yang print", "@budi yang urus konsumsi").
BUKAN janji: pertanyaan, candaan/sarkasme ("iya deh aku yang salah"), cerita masa lalu, informasi jadwal umum, keluhan, atau ajakan tanpa pemilik jelas.

Balas HANYA JSON valid, tanpa teks lain:
{"isPromise": boolean, "task": string, "ownerName": string|null, "deadlineText": string|null, "confidence": number, "mood": "santai"|"serius"|"tegang"|"sedih", "reply": string|null}

- task: tugasnya singkat, kata kerja di depan (mis. "bikin PPT presentasi"). "" kalau bukan janji.
- ownerName: null kalau pemiliknya penulis pesan; isi nama kalau pesan menunjuk orang lain.
- deadlineText: kutip persis ungkapan waktunya dari pesan ("Jumat", "besok sore", "tgl 30"); null kalau tidak ada.
- confidence: 0..1.
- mood: suasana obrolan saat ini dilihat dari konteks (petunjuk awal: ${input.moodHint}). Kalau ragu antara santai dan serius, pilih serius.
- reply: kalau janji, SATU kalimat (maks 2) seperti teman sekelas yang ikut nimbrung: tanya apakah beneran jadi; kalau dia konfirmasi (klik tombol), kamu catat & ingetin menjelang deadline. Tulis pemiliknya PERSIS sebagai "@PEMILIK" (token ini, bukan nama aslinya), sekali saja. Tanpa link. null kalau bukan janji.

Aturan gaya untuk "reply":
${personaRules(input.speechLevel, input.moodHint)}

${EXAMPLES}
Sekarang: ${input.nowWIB} (Asia/Jakarta).`,
    },
    {
      role: 'user',
      content: `${input.recent.length ? `Obrolan sebelumnya (konteks suasana, lama → baru):\n${input.recent.join('\n')}\n\n` : ''}Penulis pesan terakhir: ${input.authorName}${input.mentionNames.length ? `\nDisebut: ${input.mentionNames.join(', ')}` : ''}\nPesan terakhir: """${input.text}"""`,
    },
  ];
}
