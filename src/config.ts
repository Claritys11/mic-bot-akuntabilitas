import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  // ID Discord orang yang menjalankan bot: menerima DM kalau bot sempat mati / scheduler macet.
  OPERATOR_DISCORD_ID: optionalString,

  // WhatsApp (Baileys, tidak resmi). Sesi login disimpan di WA_AUTH_DIR — rahasia, jangan di-commit.
  WHATSAPP_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  WA_PHONE_NUMBER: z.preprocess((v) => (typeof v === 'string' ? v.replace(/[\s+()-]/g, '') || undefined : v), z.string().regex(/^\d{8,15}$/, 'angka saja dengan kode negara, mis. 6281234567890').optional()),
  WA_AUTH_DIR: z.preprocess(emptyToUndefined, z.string().default('./data/wa-auth')),

  MONGODB_URI: z.preprocess(emptyToUndefined, z.string().default('mongodb://localhost:27017/mic')),

  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default('https://openrouter.ai/api/v1')),
  LLM_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  // Dipakai otomatis kalau key utama ditolak / habis kuota / rate limit.
  BACKUP_OPENROUTER_API_KEY: optionalString,
  LLM_TEXT_MODEL: z.preprocess(emptyToUndefined, z.string().default('z-ai/glm-5.3-flash')),
  LLM_VISION_MODEL: z.preprocess(emptyToUndefined, z.string().default('z-ai/glm-5.3-flash')),
  LLM_VISION_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  LLM_VISION_API_KEY: optionalString,
  // Hermes Agent API server tidak selalu mendukung response_format; matikan kalau perlu.
  LLM_JSON_MODE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true')),
  // OpenRouter: pilih penyedia model tercepat. Untuk GLM, penyedia default bisa "berpikir"
  // ratusan token dulu (3–9 dtk); urut latency ~1–2 dtk. "default" = biarkan OpenRouter memilih.
  LLM_PROVIDER_SORT: z.preprocess(emptyToUndefined, z.enum(['latency', 'throughput', 'price', 'default']).default('latency')),
  // OpenRouter: 'deny' = hanya provider yang tidak menyimpan/melatih dari prompt (data siswa). Default deny.
  LLM_DATA_COLLECTION: z.preprocess(emptyToUndefined, z.enum(['allow', 'deny']).default('deny')),
  LLM_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(60_000)),

  // Feed RSS/Atom info lomba & beasiswa (dipisah koma, https). "off" = tidak mengambil otomatis.
  LOMBA_FEEDS: z.preprocess(emptyToUndefined, z.string().default('https://www.lombasma.com/feed,https://www.indbeasiswa.com/feed')),
  TZ: z.preprocess(emptyToUndefined, z.string().default('Asia/Jakarta')),
  DEMO_TIME_SCALE: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1)),
});

export interface LLMEndpoint {
  baseUrl: string;
  apiKey: string | undefined;
  backupApiKey?: string;
  model: string;
}

export interface Config {
  discord: { token?: string; clientId?: string; guildId?: string; operatorId?: string };
  whatsapp: { enabled: boolean; phoneNumber?: string; authDir: string };
  mongoUri: string;
  llm: {
    text: LLMEndpoint;
    vision: LLMEndpoint;
    jsonMode: boolean;
    timeoutMs: number;
    providerSort?: 'latency' | 'throughput' | 'price';
    dataCollection: 'allow' | 'deny';
  };
  demoTimeScale: number;
  lombaFeeds: string[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi env tidak valid:\n${issues}`);
  }
  const e = parsed.data;
  const textKey = e.LLM_API_KEY ?? e.OPENROUTER_API_KEY;
  const visionBase = e.LLM_VISION_BASE_URL ?? e.LLM_BASE_URL;
  // Key cadangan OpenRouter hanya dikirim ke OpenRouter, jangan ke endpoint lain (mis. Hermes lokal).
  const backupFor = (baseUrl: string) => (new URL(baseUrl).hostname.endsWith('openrouter.ai') ? e.BACKUP_OPENROUTER_API_KEY : undefined);
  return {
    discord: { token: e.DISCORD_TOKEN, clientId: e.DISCORD_CLIENT_ID, guildId: e.DISCORD_GUILD_ID, operatorId: e.OPERATOR_DISCORD_ID },
    whatsapp: { enabled: e.WHATSAPP_ENABLED === 'true', phoneNumber: e.WA_PHONE_NUMBER, authDir: e.WA_AUTH_DIR },
    mongoUri: e.MONGODB_URI,
    llm: {
      text: { baseUrl: e.LLM_BASE_URL, apiKey: textKey ?? e.BACKUP_OPENROUTER_API_KEY, backupApiKey: backupFor(e.LLM_BASE_URL), model: e.LLM_TEXT_MODEL },
      vision: {
        baseUrl: visionBase,
        apiKey: (e.LLM_VISION_API_KEY ?? (e.LLM_VISION_BASE_URL ? e.OPENROUTER_API_KEY : textKey)) ?? backupFor(visionBase),
        backupApiKey: backupFor(visionBase),
        model: e.LLM_VISION_MODEL,
      },
      jsonMode: e.LLM_JSON_MODE === 'true',
      timeoutMs: e.LLM_TIMEOUT_MS,
      providerSort: e.LLM_PROVIDER_SORT === 'default' ? undefined : e.LLM_PROVIDER_SORT,
      dataCollection: e.LLM_DATA_COLLECTION,
    },
    demoTimeScale: e.DEMO_TIME_SCALE,
    lombaFeeds: e.LOMBA_FEEDS === 'off' ? [] : e.LOMBA_FEEDS.split(',').map((u) => u.trim()).filter((u) => /^https:\/\//.test(u)),
  };
}

/** Token Discord kalau ada; null = adapter Discord tidak dijalankan. */
export function discordOptions(config: Config): { token: string; guildId?: string } | null {
  const { token, guildId } = config.discord;
  // DISCORD_CLIENT_ID tidak lagi wajib: application id dibaca dari sesi login.
  return token ? { token, guildId } : null;
}
