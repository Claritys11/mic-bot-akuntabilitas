import type { ChatMessage } from '../provider.ts';

const STYLE = {
  santai: 'santai kayak ngobrol sama teman (boleh "wkwk", "hahaha", "nih", "dong"), maks 1 emoji',
  sopan: 'sopan tapi hangat, bahasa Indonesia baku ringan',
  krama: 'bahasa Jawa krama yang halus',
} as const;

export function promisePrompt(input: {
  text: string;
  authorName: string;
  mentionNames: string[];
  nowWIB: string;
  speechLevel: 'santai' | 'sopan' | 'krama';
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `Kamu pengekstrak janji/komitmen dari obrolan grup kelas SMK berbahasa Indonesia (boleh campur Jawa/slang).
Janji = seseorang menyatakan AKAN mengerjakan tugas tertentu untuk kelompok/kelas ("aku yang bikin PPT", "biar saya yang print", "@budi yang urus konsumsi").
BUKAN janji: pertanyaan, candaan, informasi jadwal umum, keluhan, atau ajakan tanpa pemilik jelas.

Balas HANYA JSON valid, tanpa teks lain:
{"isPromise": boolean, "task": string, "ownerName": string|null, "deadlineText": string|null, "confidence": number, "reply": string|null}

- task: tugasnya singkat, kata kerja di depan (mis. "bikin PPT presentasi"). "" kalau bukan janji.
- ownerName: null kalau pemiliknya penulis pesan; isi nama kalau pesan menunjuk orang lain.
- deadlineText: kutip persis ungkapan waktunya dari pesan ("Jumat", "besok sore", "tgl 30"); null kalau tidak ada.
- confidence: 0..1.
- reply: kalau janji, SATU kalimat pendek seolah kamu teman sekelas yang ikut nimbrung di obrolan: tanya apakah beneran jadi, dan bilang bakal kamu catat/ingetin kalau jadi. Sebut pemilik janji dengan token persis @PEMILIK. Gaya bahasa: ${STYLE[input.speechLevel]}. Jangan kaku, jangan pakai link. null kalau bukan janji.
  Contoh santai: "jadi gak @PEMILIK? kalau jadi langsung ku catat nih hahaha"
Sekarang: ${input.nowWIB} (Asia/Jakarta).`,
    },
    {
      role: 'user',
      content: `Penulis: ${input.authorName}${input.mentionNames.length ? `\nDisebut: ${input.mentionNames.join(', ')}` : ''}\nPesan: """${input.text}"""`,
    },
  ];
}
