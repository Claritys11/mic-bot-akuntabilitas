// Ambil info lomba/beasiswa dari feed sekarang juga (biasanya otomatis tiap hari): bun run lomba:ambil
import { loadConfig } from '../src/config.ts';
import { connectDb, disconnectDb } from '../src/db/connect.ts';
import { runFeedsOnce } from '../src/jobs/feeds.ts';
import { OpenRouterProvider } from '../src/llm/openrouter.ts';
import { webReader } from '../src/tools/reader.ts';

const config = loadConfig();
const llm = OpenRouterProvider.fromConfig(config);
if (!llm.enabled) throw new Error('Isi OPENROUTER_API_KEY dulu — data lomba dibaca dengan AI');
await connectDb(config.mongoUri);
console.log(`Sumber: ${config.lombaFeeds.join(', ') || '(kosong — isi LOMBA_FEEDS)'}`);
const r = await runFeedsOnce(llm, webReader, config.lombaFeeds);
console.log(`${r.read} item baru dibaca, ${r.added.length} ditambahkan:`);
for (const t of r.added) console.log(`  + ${t}`);
console.log(`LLM ${JSON.stringify(llm.usage())}`);
await disconnectDb();
