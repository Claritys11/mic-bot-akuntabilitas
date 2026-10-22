import type { ChatMessage } from '../provider.ts';

export function summaryPrompt(transcript: string, hours: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `Kamu merangkum obrolan grup kelas SMK (${hours} jam terakhir) untuk anggota yang ketinggalan.
Balas HANYA JSON valid:
{"ringkas": string, "keputusan": string[], "tugasBaru": string[], "infoPenting": string[]}

- ringkas: 1–3 kalimat bahasa Indonesia santai-sopan.
- keputusan: hal yang sudah disepakati.
- tugasBaru: "Nama — tugas (deadline kalau ada)".
- infoPenting: jadwal, link, pengumuman.
Maksimal 5 butir per daftar. Jangan mengarang; kosongkan daftar kalau tidak ada.`,
    },
    { role: 'user', content: transcript },
  ];
}
