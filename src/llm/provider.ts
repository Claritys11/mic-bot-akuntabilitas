import type { z } from 'zod';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** Minta output JSON (response_format kalau didukung, plus instruksi di prompt). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface LLMProvider {
  readonly enabled: boolean;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  vision(prompt: string, image: { data: Uint8Array; mimeType: string }, opts?: ChatOptions): Promise<string>;
  usage(): LLMUsage;
}

/** Ambil objek JSON pertama dari teks (model kadang membungkus dengan ```json atau kalimat). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** Parse + validasi zod. Gagal → null (jangan crash; lihat CLAUDE.md). */
export function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  const result = schema.safeParse(extractJson(text));
  return result.success ? result.data : null;
}

export async function chatJson<T>(
  llm: LLMProvider,
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts: Omit<ChatOptions, 'json'> = {},
): Promise<T | null> {
  if (!llm.enabled) return null;
  try {
    const out = await llm.chat(messages, { ...opts, json: true });
    const parsed = parseJson(schema, out);
    if (!parsed) console.warn('[llm] output JSON tidak valid, diabaikan:', out.slice(0, 200));
    return parsed;
  } catch (err) {
    console.warn('[llm] chat gagal:', (err as Error).message);
    return null;
  }
}

export async function visionJson<T>(
  llm: LLMProvider,
  schema: z.ZodType<T>,
  prompt: string,
  image: { data: Uint8Array; mimeType: string },
): Promise<T | null> {
  if (!llm.enabled) return null;
  try {
    const out = await llm.vision(prompt, image, { json: true });
    const parsed = parseJson(schema, out);
    if (!parsed) console.warn('[llm] output vision tidak valid, diabaikan:', out.slice(0, 200));
    return parsed;
  } catch (err) {
    console.warn('[llm] vision gagal:', (err as Error).message);
    return null;
  }
}

/** Provider kosong: dipakai kalau API key belum diisi. Core jatuh ke heuristik. */
export const disabledLLM: LLMProvider = {
  enabled: false,
  chat: async () => {
    throw new Error('LLM tidak dikonfigurasi');
  },
  vision: async () => {
    throw new Error('LLM tidak dikonfigurasi');
  },
  usage: () => ({ calls: 0, promptTokens: 0, completionTokens: 0 }),
};
