import { createDiscordAdapter } from './src/adapters/discord/index.ts';
import { routeSender } from './src/adapters/router.ts';
import { createWhatsAppAdapter } from './src/adapters/whatsapp/index.ts';
import { discordOptions, loadConfig } from './src/config.ts';
import { createCore } from './src/core/index.ts';
import { seedOpportunities } from './src/core/opps/service.ts';
import { Clock, now, setClock } from './src/core/time.ts';
import type { Platform, Sender } from './src/core/types.ts';
import { connectDb, disconnectDb } from './src/db/connect.ts';
import { OpenRouterProvider } from './src/llm/openrouter.ts';
import { startScheduler } from './src/scheduler/index.ts';

const config = loadConfig();
const discord = discordOptions(config);
if (!discord && !config.whatsapp.enabled) {
  console.error('[app] Tidak ada platform aktif. Isi DISCORD_TOKEN dan/atau WHATSAPP_ENABLED=true di .env.');
  process.exit(1);
}
setClock(new Clock(config.demoTimeScale));

await connectDb(config.mongoUri);
const seeded = await seedOpportunities(now());
if (seeded) console.log(`[db] seed ${seeded} info lomba`);

const llm = OpenRouterProvider.fromConfig(config);
console.log(`[llm] ${llm.enabled ? `aktif → ${config.llm.text.baseUrl} (${config.llm.text.model})` : 'nonaktif — deteksi janji pakai heuristik'}`);

const core = createCore(llm);
const senders: Partial<Record<Platform, Sender>> = {};
const stops: (() => Promise<void>)[] = [];

function explainDiscordError(err: unknown) {
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
}

if (discord) {
  const adapter = createDiscordAdapter(core, discord);
  try {
    await adapter.start();
    senders.discord = adapter.sender;
    stops.push(adapter.stop);
  } catch (err) {
    explainDiscordError(err);
  }
}

if (config.whatsapp.enabled) {
  const adapter = createWhatsAppAdapter(core, config.whatsapp);
  try {
    await adapter.start();
    senders.whatsapp = adapter.sender;
    stops.push(adapter.stop);
  } catch (err) {
    console.error('[whatsapp] gagal mulai:', err instanceof Error ? err.message : err);
  }
}

if (!Object.keys(senders).length) {
  await disconnectDb();
  process.exit(1);
}
const stopScheduler = startScheduler(core, routeSender(senders));

const shutdown = async (signal: string) => {
  console.log(`[app] ${signal}, mematikan...`);
  stopScheduler();
  for (const stop of stops) await stop().catch(() => undefined);
  await disconnectDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[app] unhandledRejection:', err));
