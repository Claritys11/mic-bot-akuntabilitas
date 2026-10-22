import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,

  MONGODB_URI: z.preprocess(emptyToUndefined, z.string().default('mongodb://localhost:27017/mic')),

  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default('https://openrouter.ai/api/v1')),
  LLM_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  LLM_TEXT_MODEL: z.preprocess(emptyToUndefined, z.string().default('nousresearch/hermes-4-70b')),
  LLM_VISION_MODEL: z.preprocess(emptyToUndefined, z.string().default('google/gemini-2.5-flash')),
  LLM_VISION_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  LLM_VISION_API_KEY: optionalString,
  // Hermes Agent API server tidak selalu mendukung response_format; matikan kalau perlu.
  LLM_JSON_MODE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true')),
  LLM_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(60_000)),

  TZ: z.preprocess(emptyToUndefined, z.string().default('Asia/Jakarta')),
  DEMO_TIME_SCALE: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1)),
});

export interface LLMEndpoint {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

export interface Config {
  discord: { token?: string; clientId?: string; guildId?: string };
  mongoUri: string;
  llm: {
    text: LLMEndpoint;
    vision: LLMEndpoint;
    jsonMode: boolean;
    timeoutMs: number;
  };
  demoTimeScale: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi env tidak valid:\n${issues}`);
  }
  const e = parsed.data;
  const textKey = e.LLM_API_KEY ?? e.OPENROUTER_API_KEY;
  return {
    discord: { token: e.DISCORD_TOKEN, clientId: e.DISCORD_CLIENT_ID, guildId: e.DISCORD_GUILD_ID },
    mongoUri: e.MONGODB_URI,
    llm: {
      text: { baseUrl: e.LLM_BASE_URL, apiKey: textKey, model: e.LLM_TEXT_MODEL },
      vision: {
        baseUrl: e.LLM_VISION_BASE_URL ?? e.LLM_BASE_URL,
        apiKey: e.LLM_VISION_API_KEY ?? (e.LLM_VISION_BASE_URL ? e.OPENROUTER_API_KEY : textKey),
        model: e.LLM_VISION_MODEL,
      },
      jsonMode: e.LLM_JSON_MODE === 'true',
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    demoTimeScale: e.DEMO_TIME_SCALE,
  };
}

export function requireDiscord(config: Config): { token: string; guildId?: string } {
  const { token, guildId } = config.discord;
  if (!token) throw new Error('DISCORD_TOKEN wajib diisi untuk menjalankan bot Discord.');
  // DISCORD_CLIENT_ID tidak lagi wajib: application id dibaca dari sesi login.
  return { token, guildId };
}
