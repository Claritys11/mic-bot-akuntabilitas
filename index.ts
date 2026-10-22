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
try {
  await adapter.start();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/disallowed intents/i.test(msg)) {
    console.error(
      '[discord] Intent belum diizinkan. Buka https://discord.com/developers/applications → aplikasi bot ini → Bot →\n' +
        '          nyalakan "Server Members Intent" dan "Message Content Intent", simpan, lalu jalankan ulang.',
    );
  } else if (/invalid token|TokenInvalid/i.test(msg)) {
    console.error('[discord] DISCORD_TOKEN ditolak Discord. Reset token di Developer Portal → Bot, lalu salin ulang ke .env.');
  } else {
    console.error('[discord] gagal login:', err);
  }
  await disconnectDb();
  process.exit(1);
}
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
