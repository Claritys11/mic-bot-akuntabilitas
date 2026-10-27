// Cek sebelum demo/presentasi: bun run demo:check
// Memastikan semua yang dipakai saat demo hidup, tanpa menyentuh server Discord.
import { PNG } from 'pngjs';
import { z } from 'zod';
import { discordOptions, loadConfig } from '../src/config.ts';
import { looksLikePromise, heuristicExtract } from '../src/core/promises/prefilter.ts';
import { connectDb, disconnectDb } from '../src/db/connect.ts';
import { GroupModel } from '../src/db/models.ts';
import { OpenRouterProvider } from '../src/llm/openrouter.ts';
import { kasProofPrompt } from '../src/llm/prompts/kasProof.ts';
import { promisePrompt } from '../src/llm/prompts/promise.ts';
import { parseJson } from '../src/llm/provider.ts';

let failed = 0;
const ok = (msg: string) => console.log(`✅ ${msg}`);
const bad = (msg: string, hint?: string) => {
  failed++;
  console.log(`❌ ${msg}${hint ? `\n   → ${hint}` : ''}`);
};
const warn = (msg: string) => console.log(`⚠️  ${msg}`);
const timed = async <T>(fn: () => Promise<T>) => {
  const t = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - t };
};

const config = loadConfig();
if (discordOptions(config)) ok('DISCORD_TOKEN terisi');
else if (config.whatsapp.enabled) warn('DISCORD_TOKEN kosong — hanya WhatsApp');
else bad('Tidak ada platform aktif', 'isi DISCORD_TOKEN di .env');

try {
  await connectDb(config.mongoUri);
  const groups = await GroupModel.find({}, { className: 1, platform: 1, pilotMode: 1 }).lean();
  ok(`MongoDB terhubung · ${groups.length} kelas: ${groups.map((g) => `${g.className}${g.pilotMode === 'diam' ? ' (MODE DIAM!)' : ''}`).join(', ') || '—'}`);
  if (groups.some((g) => g.pilotMode === 'diam')) warn('Ada kelas dalam mode diam — bot tidak akan membalas di sana. `/pilot mode aktif` sebelum demo.');
} catch (err) {
  bad('MongoDB tidak terhubung', `docker compose up -d mongo (${(err as Error).message})`);
}

// Cadangan tanpa LLM harus selalu jalan — ini yang tampil kalau API bermasalah saat presentasi.
const fallbackText = 'aku yang bikin PPT ya, Jumat jadi';
if (looksLikePromise(fallbackText) && heuristicExtract(fallbackText)?.task) ok('Cadangan tanpa LLM (heuristik) mendeteksi janji');
else bad('Heuristik cadangan gagal mendeteksi janji demo');

const llm = OpenRouterProvider.fromConfig(config);
if (!llm.enabled) {
  warn('LLM nonaktif — demo tetap jalan dengan heuristik, tanpa baca bukti transfer & rangkuman');
} else {
  const PromiseOut = z.object({ isPromise: z.boolean(), confidence: z.number().default(0), reply: z.string().nullish() });
  try {
    const { v, ms } = await timed(() =>
      llm.chat(promisePrompt({ text: fallbackText, authorName: 'Ani', mentionNames: [], nowWIB: 'Senin, 2 Nov 2026 10:00 WIB', speechLevel: 'santai', moodHint: 'santai', recent: [] }), { json: true, maxTokens: 300 }),
    );
    const out = parseJson(PromiseOut, v);
    if (!out?.isPromise) bad(`LLM teks (${config.llm.text.model}) tidak mengenali janji demo`, v.slice(0, 160));
    else {
      ok(`LLM teks ${config.llm.text.model}: ${ms} ms, confidence ${out.confidence}${out.confidence >= 0.8 ? ' (akan auto-aktif)' : ' (akan minta konfirmasi)'}`);
      if (ms > 4000) warn('Balasan > 4 dtk — cek LLM_PROVIDER_SORT=latency atau koneksi');
    }
  } catch (err) {
    bad(`LLM teks gagal: ${(err as Error).message}`, 'cek OPENROUTER_API_KEY, saldo, dan batas belanja key');
  }

  // Gambar polos 64×64 — cukup untuk memastikan endpoint vision menerima gambar.
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  try {
    const { v, ms } = await timed(() => llm.vision(kasProofPrompt('Senin, 2 Nov 2026 10:00 WIB'), { data: new Uint8Array(PNG.sync.write(png)), mimeType: 'image/png' }, { json: true }));
    if (parseJson(z.object({ isTransferProof: z.boolean() }), v)) ok(`LLM vision ${config.llm.vision.model}: ${ms} ms`);
    else bad('LLM vision menjawab tapi bukan JSON yang diharapkan', v.slice(0, 160));
  } catch (err) {
    bad(`LLM vision gagal: ${(err as Error).message}`, 'LLM_VISION_MODEL harus mendukung gambar');
  }
}

if (config.demoTimeScale === 1) warn('DEMO_TIME_SCALE=1 (waktu normal). Untuk demo tagihan cepat: DEMO_TIME_SCALE=1440 (1 menit = 1 hari), lalu restart bot');
else ok(`DEMO_TIME_SCALE=${config.demoTimeScale} (1 menit nyata ≈ ${Math.round(config.demoTimeScale / 60)} jam virtual)`);

await disconnectDb().catch(() => undefined);
console.log(failed ? `\n${failed} masalah — perbaiki sebelum demo.` : '\nSiap demo 🚀');
process.exit(failed ? 1 : 0);
