import { createDiscordAdapter } from './src/adapters/discord/index.ts';
import { loadConfig, requireDiscord } from './src/config.ts';
import { createCore } from './src/core/index.ts';
import { seedOpportunities } from './src/core/opps/service.ts';
import { Clock, now, setClock } from './src/core/time.ts';
import { connectDb, disconnectDb } from './src/db/connect.ts';
import { OpenRouterProvider } from './src/llm/openrouter.ts';
import { startScheduler } from './src/scheduler/index.ts';

const config = loadConfig();
const discord = requireDiscord(config);
setClock(new Clock(config.demoTimeScale));

await connectDb(config.mongoUri);
const seeded = await seedOpportunities(now());
if (seeded) console.log(`[db] seed ${seeded} info lomba`);

const llm = OpenRouterProvider.fromConfig(config);
console.log(`[llm] ${llm.enabled ? `aktif → ${config.llm.text.baseUrl} (${config.llm.text.model})` : 'nonaktif — deteksi janji pakai heuristik'}`);

const core = createCore(llm);
const adapter = createDiscordAdapter(core, discord);
await adapter.start();
const stopScheduler = startScheduler(core, adapter.sender);

const shutdown = async (signal: string) => {
  console.log(`[app] ${signal}, mematikan...`);
  stopScheduler();
  await adapter.stop();
  await disconnectDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[app] unhandledRejection:', err));
