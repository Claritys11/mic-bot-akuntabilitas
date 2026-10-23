// Evaluasi "suara" bot ke LLM sungguhan: skenario obrolan dengan berbagai suasana.
// Jalankan: bun run eval:voice   (butuh OPENROUTER_API_KEY; tidak menyentuh database)
// Dipakai untuk menyetel prompt di src/llm/prompts/{persona,promise,ask}.ts.

import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { detectMood, graverMood, tidyReply } from '../src/core/chat/mood.ts';
import { acceptLlmLine } from '../src/core/promises/voice.ts';
import { OpenRouterProvider } from '../src/llm/openrouter.ts';
import { askPrompt } from '../src/llm/prompts/ask.ts';
import type { Level } from '../src/llm/prompts/persona.ts';
import { promisePrompt } from '../src/llm/prompts/promise.ts';
import { parseJson } from '../src/llm/provider.ts';

const llm = OpenRouterProvider.fromConfig(loadConfig());
if (!llm.enabled) throw new Error('Isi OPENROUTER_API_KEY dulu');

const NOW = 'Jumat, 23 Okt 2026 19:00 WIB';
const LAUGH = /haha|hehe|wkwk|😂|🤣|😆/i;

interface Case {
  name: string;
  level?: Level;
  recent: string[];
  author?: string;
  text: string;
  /** Harapan untuk penilaian otomatis sederhana. */
  expect: { promise?: boolean; noLaugh?: boolean; silent?: boolean; mustMention?: RegExp; mustNotMention?: RegExp };
}

const PROMISES: Case[] = [
  { name: 'santai biasa', recent: ['Budi: ppt nya siapa nih wkwk', 'Sari: gas lah bagi tugas'], text: 'aku yang bikin PPT ya, jumat jadi', expect: { promise: true } },
  { name: 'serius: ujian', recent: ['Sari: besok ulangan bab 3 gaes', 'Budi: materinya banyak banget, serius'], text: 'aku yang rangkum materi bab 3 nanti malam', expect: { promise: true, noLaugh: true } },
  { name: 'sedih: kabar duka', recent: ['Sari: gaes ibunya Rina meninggal tadi pagi', 'Budi: innalillahi'], text: 'aku yang koordinir patungan buat Rina ya, besok', expect: { promise: true, noLaugh: true } },
  { name: 'tegang: kesal', recent: ['Sari: kok belum ada yang ngerjain sih, besok dikumpul', 'Budi: parah sih ini'], text: 'yaudah aku yang kerjain bab 2 malam ini', expect: { promise: true, noLaugh: true } },
  { name: 'sarkas bukan janji', recent: ['Sari: kamu sih telat terus'], text: 'iya deh aku yang salah', expect: { promise: false } },
  { name: 'tingkat sopan', level: 'sopan', recent: [], text: 'saya yang print laporannya besok pagi', expect: { promise: true } },
  { name: 'menunjuk orang lain', recent: ['Ani: poster siapa yang bikin?'], author: 'Ani', text: '@Budi yang bikin poster ya, senin', expect: { promise: true } },
];

const FACTS_2 = {
  kelas: 'XI International',
  sekarang: NOW,
  penanya: 'Ani',
  janji: [
    { tugas: 'bikin PPT presentasi', pemilik: 'Budi', deadline: 'Senin, 26 Okt 20:00 WIB', lewat: false, punyaPenanya: false },
    { tugas: 'print laporan', pemilik: 'Ani', deadline: 'Kamis, 22 Okt 07:00 WIB', lewat: true, punyaPenanya: true },
  ],
  janjiMenungguKonfirmasi: 0,
};
const FACTS_0 = { kelas: 'XI International', sekarang: NOW, penanya: 'Ani', janji: [], janjiMenungguKonfirmasi: 0 };
const FACTS_KAS = {
  kelas: 'XI International',
  sekarang: NOW,
  penanya: 'Ani',
  kas: { iuran: 'Rp10.000', periode: 'Oktober 2026', penanyaSudahBayar: false, penanyaTercatat: 'Rp0', jumlahSudah: 12, jumlahBelum: 20, saldo: 'Rp120.000', kirimBuktiDi: 'channel kas' },
};

const ASKS: (Case & { addressed: boolean; facts: unknown })[] = [
  { name: 'ada tugas (2 janji)', addressed: false, facts: FACTS_2, recent: ['Budi: gabut nih'], text: 'ada tugas gak nih?', expect: { mustMention: /PPT/ } },
  { name: 'ada tugas (kosong)', addressed: false, facts: FACTS_0, recent: [], text: 'ada tugas gak nih', expect: { mustMention: /belum|ga ada|gak ada|nggak ada|kosong/i } },
  { name: 'serius: deadline minggu ini', addressed: false, facts: FACTS_2, recent: ['Sari: senin ujian praktik loh', 'Budi: serius? belum belajar'], text: 'deadline apa aja minggu ini?', expect: { noLaugh: true, mustMention: /PPT/ } },
  { name: 'kas penanya belum bayar', addressed: true, facts: FACTS_KAS, recent: [], text: '@MIC kas aku udah lunas belum?', expect: { mustMention: /belum/i, mustNotMention: /Budi|Sari/ } },
  { name: 'sapaan', addressed: true, facts: { kelas: 'XI International', sekarang: NOW, penanya: 'Ani' }, recent: [], text: '@MIC halo', expect: {} },
  { name: 'minta kerjain PR', addressed: true, facts: FACTS_0, recent: [], text: '@MIC kerjain PR matematika aku dong', expect: {} },
  { name: 'sedih + tanya tugas', addressed: false, facts: FACTS_2, recent: ['Sari: Budi kecelakaan tadi, lagi di rumah sakit', 'Ani: ya Allah semoga cepet sembuh'], text: 'tugas Budi ada apa aja ya?', expect: { noLaugh: true, mustMention: /PPT/ } },
  { name: 'diledek', addressed: true, facts: FACTS_2, recent: ['Budi: tugasnya numpuk anjir'], text: '@MIC bot ga guna, tugas tetep numpuk', expect: { noLaugh: true } },
  { name: 'krama', level: 'krama', addressed: false, facts: FACTS_2, recent: [], text: 'wonten tugas menapa mboten?', expect: { mustMention: /PPT/ } },
  {
    name: 'info lomba',
    addressed: false,
    facts: { kelas: 'XI International', sekarang: NOW, penanya: 'Ani', lomba: [{ judul: 'Hology 8.0 CTF', penyelenggara: 'UB', deadline: '5 Nov 2026' }, { judul: 'Gemastik', penyelenggara: 'Kemdikbud', deadline: '20 Nov 2026' }] },
    recent: [],
    text: 'ada lomba ga?',
    expect: { mustMention: /Hology/ },
  },
  { name: 'pertanyaan ke orang lain', addressed: false, facts: FACTS_2, recent: ['Rina: aku tadi ke dokter gigi'], text: 'Rin, giginya udah gapapa belum? kemarin katanya sakit, tugas biologi kamu gimana?', expect: {} },
];

const PromiseOut = z.object({ isPromise: z.boolean(), task: z.string().default(''), mood: z.string().nullish(), reply: z.string().nullish() });
const AskOut = z.object({ mood: z.enum(['santai', 'serius', 'tegang', 'sedih']).nullish().catch(null), reply: z.string().nullish() });

let pass = 0;
let total = 0;
const verdict = (ok: boolean, why: string) => {
  total += 1;
  if (ok) pass += 1;
  return ok ? '✅' : `❌ ${why}`;
};
const lines = (r: string[]) => r.map((l) => l.replace(/^[^:]+: /, ''));

for (const c of PROMISES) {
  const level = c.level ?? 'santai';
  const hint = detectMood([...lines(c.recent), c.text]);
  const t = Date.now();
  const raw = await llm.chat(
    promisePrompt({ text: c.text, authorName: c.author ?? 'Ani', mentionNames: c.text.includes('@Budi') ? ['Budi'] : [], nowWIB: NOW, speechLevel: level, moodHint: hint, recent: c.recent }),
    { json: true, maxTokens: 300 },
  ).catch((e: Error) => `ERROR ${e.message}`);
  const out = parseJson(PromiseOut, raw);
  const mood = graverMood(hint, (out?.mood as never) ?? null);
  const reply = acceptLlmLine(out?.reply ?? null, '‹pemilik›', mood, ['Ani', 'Budi']);
  const checks = [
    c.expect.promise !== undefined ? verdict(out?.isPromise === c.expect.promise, `isPromise=${out?.isPromise}`) : '',
    c.expect.promise ? verdict(Boolean(reply), 'reply ditolak/kosong → template') : '',
    c.expect.noLaugh ? verdict(!LAUGH.test(out?.reply ?? ''), 'LLM tertawa (dibuang pagar)') : '',
  ].filter(Boolean);
  console.log(`\n[janji] ${c.name}  (${Date.now() - t} ms, hint=${hint}, mood=${mood})\n  "${c.text}"\n  → ${reply ?? `(null) raw=${out?.reply ?? raw.slice(0, 120)}`}\n  ${checks.join(' ')}`);
}

for (const c of ASKS) {
  const hint = detectMood([...lines(c.recent), c.text]);
  const t = Date.now();
  const raw = await llm.chat(
    askPrompt({ text: c.text, authorName: 'Ani', addressedToBot: c.addressed, speechLevel: c.level ?? 'santai', moodHint: hint, recent: c.recent, facts: c.facts }),
    { json: true, maxTokens: 500, temperature: 0.6 },
  ).catch((e: Error) => `ERROR ${e.message}`);
  const out = parseJson(AskOut, raw);
  const mood = graverMood(hint, out?.mood ?? null);
  const reply = out?.reply ? tidyReply(out.reply, mood) : null;
  const checks = [
    c.expect.noLaugh ? verdict(!LAUGH.test(out?.reply ?? ''), 'LLM tertawa (dibuang pagar)') : '',
    c.expect.mustMention ? verdict(c.expect.mustMention.test(reply ?? ''), `tidak menyebut ${c.expect.mustMention}`) : '',
    c.expect.mustNotMention ? verdict(!c.expect.mustNotMention.test(reply ?? ''), 'membocorkan nama') : '',
    c.addressed ? verdict(Boolean(reply), 'di-tag tapi diam') : '',
  ].filter(Boolean);
  console.log(`\n[tanya] ${c.name}  (${Date.now() - t} ms, hint=${hint}, mood=${mood})\n  "${c.text}"\n  → ${reply ?? '(diam)'}\n  ${checks.join(' ')}`);
}

console.log(`\nSkor: ${pass}/${total} cek lolos · LLM ${JSON.stringify(llm.usage())}`);
