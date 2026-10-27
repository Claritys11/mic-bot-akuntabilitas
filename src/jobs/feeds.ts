import { importFeeds, type PageReader } from '../core/opps/importer.ts';
import { catalog, feedTargets } from '../core/opps/sources.ts';
import { now } from '../core/time.ts';
import { JobRunModel } from '../db/models.ts';
import type { LLMProvider } from '../llm/provider.ts';

// Ambil info lomba/beasiswa dari feed sekali sehari (dicek tiap jam, aman restart: jadwal di DB).

const JOB_ID = 'lomba-feeds';
const EVERY_MS = 20 * 3600_000;

export async function runFeedsOnce(llm: LLMProvider, reader: PageReader, feeds: string[]) {
  const r = await importFeeds(llm, reader, await feedTargets(catalog(feeds)), now());
  await JobRunModel.updateOne({ _id: JOB_ID }, { $set: { lastRunAt: new Date(), note: `${r.read} dibaca, ${r.added.length} ditambah` } }, { upsert: true });
  if (r.read) console.log(`[lomba] feed: ${r.read} item dibaca, ${r.added.length} lomba/beasiswa baru${r.added.length ? `: ${r.added.join('; ')}` : ''}`);
  return r;
}

export function startFeedJob(llm: LLMProvider, reader: PageReader, feeds: string[]): () => void {
  if (!feeds.length || !llm.enabled) {
    console.log('[lomba] ambil feed otomatis nonaktif' + (llm.enabled ? ' (LOMBA_FEEDS=off)' : ' (LLM belum aktif)'));
    return () => undefined;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const last = await JobRunModel.findById(JOB_ID).lean();
      if (!last || Date.now() - last.lastRunAt.getTime() >= EVERY_MS) await runFeedsOnce(llm, reader, feeds);
    } catch (err) {
      console.error('[lomba] ambil feed gagal:', (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 3600_000);
  setTimeout(tick, 30_000);
  console.log(`[lomba] ambil feed otomatis tiap ±20 jam dari ${feeds.length} sumber`);
  return () => clearInterval(timer);
}
