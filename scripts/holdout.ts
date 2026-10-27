// Holdout deteksi janji dari chat asli (lihat docs/PILOT.md):
//   bun run holdout prepare <ekspor.txt> <keluar.jsonl>   parse + anonimkan (nama asli tidak disimpan)
//   bun run holdout label <file.jsonl>                    beri label di terminal (y/n/s/q), disimpan tiap jawaban
//   bun run holdout eval <file.jsonl> [--tanpa-llm]       precision/recall alur penuh (prefilter + LLM + deadline)
// File .jsonl berisi chat siswa — simpan di luar repo (folder data/ sudah di .gitignore).
import { loadConfig } from '../src/config.ts';
import { looksLikePromise } from '../src/core/promises/prefilter.ts';
import { ExtractionSchema, MIN_CONFIDENCE, resolveDeadline } from '../src/core/promises/service.ts';
import { anonymize, evaluate, parseWhatsAppExport, toHoldout, type HoldoutItem, type Prediction } from '../src/tools/holdout.ts';
import { OpenRouterProvider } from '../src/llm/openrouter.ts';
import { promisePrompt } from '../src/llm/prompts/promise.ts';
import { parseJson } from '../src/llm/provider.ts';
import { formatWIB } from '../src/core/time.ts';

const [cmd, a, b] = process.argv.slice(2);
const read = async (p: string) => (await Bun.file(p).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as HoldoutItem);
const write = (p: string, items: HoldoutItem[]) => Bun.write(p, items.map((i) => JSON.stringify(i)).join('\n') + '\n');

if (cmd === 'prepare' && a && b) {
  const items = toHoldout(anonymize(parseWhatsAppExport(await Bun.file(a).text())));
  await write(b, items);
  console.log(`${items.length} pesan → ${b} (nama diganti SiswaN, nomor/email dihapus). Cek sekilas sebelum dilabeli.`);
} else if (cmd === 'label' && a) {
  const items = await read(a);
  const todo = items.filter((i) => i.label.promise === null);
  console.log(`${todo.length} pesan belum berlabel. y = janji, n = bukan, s = lewati, q = simpan & keluar.\n`);
  for (const it of todo) {
    const idx = items.indexOf(it);
    for (const c of items.slice(Math.max(0, idx - 3), idx)) console.log(`   ${c.author}: ${c.text.replace(/\n/g, ' ')}`);
    console.log(`➤ ${it.author}: ${it.text}`);
    const ans = (prompt('janji? [y/n/s/q]') ?? '').trim().toLowerCase();
    if (ans === 'q') break;
    if (ans === 'y') {
      const owner = (prompt('pemilik: [s]endiri / [o]rang lain') ?? '').trim().toLowerCase();
      it.label = { promise: true, owner: owner.startsWith('o') ? 'other' : 'self', deadline: (prompt('ungkapan deadline persis (kosong = tidak ada)') ?? '').trim() || null };
    } else if (ans === 'n') it.label = { promise: false, owner: null, deadline: null };
    await write(a, items);
    console.log('');
  }
  console.log(`Tersimpan. Berlabel: ${items.filter((i) => i.label.promise !== null).length}/${items.length}`);
} else if (cmd === 'eval' && a) {
  const items = (await read(a)).filter((i) => i.label.promise !== null);
  const useLlm = !process.argv.includes('--tanpa-llm');
  const llm = OpenRouterProvider.fromConfig(loadConfig());
  if (useLlm && !llm.enabled) throw new Error('Isi OPENROUTER_API_KEY, atau pakai --tanpa-llm (hanya prefilter)');
  const all = await read(a);
  const preds: Prediction[] = [];
  const deadlineMisses: string[] = [];
  for (const it of items) {
    const passed = looksLikePromise(it.text);
    if (!passed || !useLlm) {
      preds.push({ id: it.id, passedPrefilter: passed, predicted: passed && !useLlm });
      continue;
    }
    const at = it.at ? new Date(it.at) : new Date();
    const idx = all.findIndex((x) => x.id === it.id);
    const recent = all.slice(Math.max(0, idx - 6), idx).map((x) => `${x.author}: ${x.text}`);
    const raw = await llm
      .chat(promisePrompt({ text: it.text, authorName: it.author, mentionNames: [], nowWIB: formatWIB(at), speechLevel: 'santai', moodHint: 'santai', recent }), { json: true, maxTokens: 300 })
      .catch(() => '');
    const ex = parseJson(ExtractionSchema, raw);
    const predicted = Boolean(ex?.isPromise && ex.confidence >= MIN_CONFIDENCE && ex.task.trim());
    let deadlineMatches: boolean | null = null;
    if (predicted && it.label.deadline) {
      const want = resolveDeadline(it.label.deadline, at);
      const got = resolveDeadline(ex!.deadlineText ?? it.text, at);
      deadlineMatches = Boolean(want && got && formatWIB(want, 'date') === formatWIB(got, 'date'));
      if (!deadlineMatches) {
        deadlineMisses.push(`   #${it.id} "${it.text.slice(0, 60)}" — label "${it.label.deadline}" → ${want ? formatWIB(want) : '?'} · bot "${ex!.deadlineText ?? '-'}" → ${got ? formatWIB(got) : '?'}`);
      }
    }
    preds.push({ id: it.id, passedPrefilter: true, predicted, deadlineMatches });
  }
  const r = evaluate(items, preds);
  const show = (ids: number[]) => ids.map((id) => `   #${id} ${items.find((i) => i.id === id)!.text.replace(/\n/g, ' ').slice(0, 90)}`).join('\n') || '   —';
  console.log(`Berlabel ${r.labeled} · TP ${r.tp} · FP ${r.fp} · FN ${r.fn} · TN ${r.tn}${useLlm ? '' : '  (tanpa LLM: hanya prefilter)'}`);
  console.log(`Precision ${r.precision ?? '—'} · Recall ${r.recall ?? '—'} · F1 ${r.f1 ?? '—'}`);
  console.log(`Deadline tepat: ${r.deadline.correct}/${r.deadline.checked}`);
  if (deadlineMisses.length) console.log(deadlineMisses.join('\n'));
  console.log(`\nHilang di prefilter (permanen):\n${show(r.missedByPrefilter)}`);
  console.log(`\nDitolak LLM:\n${show(r.missedByLlm)}`);
  console.log(`\nSalah tangkap:\n${show(r.falsePositives)}`);
  console.log(`\nLLM ${JSON.stringify(llm.usage())}`);
} else {
  console.log('Pakai: bun run holdout prepare <ekspor.txt> <keluar.jsonl> | label <file.jsonl> | eval <file.jsonl> [--tanpa-llm]');
  process.exit(1);
}
