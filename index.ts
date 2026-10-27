import { createDiscordAdapter } from './src/adapters/discord/index.ts';
import { routeSender } from './src/adapters/router.ts';
import { createWhatsAppAdapter } from './src/adapters/whatsapp/index.ts';
import { discordOptions, loadConfig } from './src/config.ts';
import { createCore } from './src/core/index.ts';
import { seedOpportunities } from './src/core/opps/service.ts';
import { Clock, now, setClock } from './src/core/time.ts';
import type { Platform, Sender } from './src/core/types.ts';
import { connectDb, disconnectDb } from './src/db/connect.ts';
import { recordStartup } from './src/db/health.ts';
import { recordLlmCall } from './src/db/llmUsage.ts';
import { OpenRouterProvider } from './src/llm/openrouter.ts';
import { startFeedJob } from './src/jobs/feeds.ts';
import { startKasSheetJob } from './src/jobs/kasSheets.ts';
import { loadServiceAccount, SheetsClient } from './src/integrations/google/sheets.ts';
import { GoogleDeviceLinker } from './src/integrations/google/oauth.ts';
import { startSheetLinkJob } from './src/jobs/sheetLinks.ts';
import { startScheduler } from './src/scheduler/index.ts';
import { webReader } from './src/tools/reader.ts';

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
llm.onCall((r) => recordLlmCall(r));
console.log(`[llm] ${llm.enabled ? `aktif → ${config.llm.text.baseUrl} (${config.llm.text.model})` : 'nonaktif — deteksi janji pakai heuristik'}`);

// Google Sheets (opsional): tanpa file akun layanan, /kas sheet menjelaskan cara mengaktifkan.
let sheets: SheetsClient | undefined;
if (config.googleServiceAccountFile) {
  try {
    sheets = new SheetsClient(await loadServiceAccount(config.googleServiceAccountFile));
  } catch (err) {
    console.error('[sheets] akun layanan Google tidak bisa dibaca:', (err as Error).message);
  }
}
// Login Google pengurus (opsional): bot membuat sheet sendiri di Drive bendahara.
const sheetLinker = config.googleOAuth ? new GoogleDeviceLinker(config.googleOAuth) : undefined;
const core = createCore(llm, { reader: webReader, sheets, sheetLinker, lombaFeeds: config.lombaFeeds });
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
const router = routeSender(senders);
// Lapor ke operator lewat DM Discord (kalau OPERATOR_DISCORD_ID diisi). Gagal kirim cukup dicatat di log.
const alertOperator = (text: string) => {
  console.warn(`[health] ${text}`);
  const id = config.discord.operatorId;
  if (!id || !senders.discord) return;
  void senders.discord
    .send({ to: { kind: 'dm', member: { platform: 'discord', platformUserId: id, groupId: '', displayName: 'Operator' }, fallbackChannelId: '' }, text })
    .catch((err) => console.warn('[health] gagal DM operator:', (err as Error).message));
};
const down = await recordStartup();
if (down) alertOperator(`⚠️ MIC-Bot sempat mati ±${down.minutes} menit (sejak ${down.from.toISOString()}). Kalau sedang pilot, catat ini — data di rentang itu tidak lengkap.`);
const stopScheduler = startScheduler(core, router, undefined, alertOperator);
const stopFeeds = startFeedJob(llm, webReader, config.lombaFeeds);
const stopSheets =
  sheets || sheetLinker
    ? startKasSheetJob((g) => (g.kas?.sheetAuth ? (sheetLinker?.clientFor(g.kas.sheetAuth) ?? null) : (sheets ?? null)), [sheetLinker && 'login Google pengurus', sheets && `akun layanan ${sheets.serviceEmail}`].filter(Boolean).join(' + '))
    : () => undefined;
const stopSheetLinks = sheetLinker ? startSheetLinkJob(core, router) : () => undefined;

const shutdown = async (signal: string) => {
  console.log(`[app] ${signal}, mematikan...`);
  stopScheduler();
  stopFeeds();
  stopSheets();
  stopSheetLinks();
  for (const stop of stops) await stop().catch(() => undefined);
  await disconnectDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[app] unhandledRejection:', err));
