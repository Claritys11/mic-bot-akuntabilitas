import type { Config, LLMEndpoint } from '../config.ts';
import type { ChatMessage, ChatOptions, LLMCallRecord, LLMProvider, LLMUsage } from './provider.ts';

// Klien OpenAI-compatible. Default ke OpenRouter, tapi juga dipakai untuk API server
// Hermes Agent (profil terpisah) — cukup ganti LLM_BASE_URL.

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type WireMessage = { role: string; content: string | ContentPart[] };

interface CompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

const MIN_MAX_TOKENS = 2000;

class LLMEmptyError extends Error {
  constructor() {
    super('LLM mengembalikan respons kosong');
  }
}

class LLMHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OpenRouterProvider implements LLMProvider {
  readonly enabled: boolean;
  private stats: LLMUsage = { calls: 0, promptTokens: 0, completionTokens: 0 };

  constructor(
    private readonly text: LLMEndpoint,
    private readonly visionEp: LLMEndpoint,
    private readonly jsonMode: boolean,
    private readonly timeoutMs: number,
    private readonly providerSort?: 'latency' | 'throughput' | 'price',
    /** 'deny' = hanya provider yang tidak menyimpan/melatih dari data (bukti kas anak sekolah ikut terkirim). */
    private readonly dataCollection: 'allow' | 'deny' = 'deny',
  ) {
    this.enabled = Boolean(text.apiKey);
  }

  private usageSink?: (r: LLMCallRecord) => void;

  /** Terima catatan tiap panggilan (dipakai untuk log biaya harian; isi pesan tidak ikut). */
  onCall(sink: (r: LLMCallRecord) => void): void {
    this.usageSink = sink;
  }

  /** model|key → waktu (ms) sampai boleh dicoba lagi. */
  private cooldown = new Map<string, number>();

  /**
   * Coba setiap model (LLM_*_MODEL boleh dipisah koma) × key (utama lalu cadangan) berurutan.
   * Kombinasi yang ditolak (kuota/limit) diistirahatkan supaya tidak membuang request di tiap pesan.
   */
  private async complete(ep: LLMEndpoint, messages: WireMessage[], opts: ChatOptions): Promise<string> {
    const models = ep.model.split(',').map((m) => m.trim()).filter(Boolean);
    const keys = [ep.apiKey, ep.backupApiKey].filter((k, i, all): k is string => Boolean(k) && all.indexOf(k) === i);
    const attempts = models.flatMap((model) => keys.map((key, ki) => ({ model, key, slot: `${model}|${ki}` })));
    const at = Date.now();
    const ready = attempts.filter((a) => (this.cooldown.get(a.slot) ?? 0) <= at);
    let lastErr: unknown = new Error('LLM tidak punya API key');
    // Semua sedang istirahat → tetap coba semuanya daripada langsung gagal.
    for (const a of ready.length ? ready : attempts) {
      try {
        // Respons kosong biasanya gangguan sesaat di provider (terlihat ±6% di uji vision) → ulang sekali.
        const out = await this.request(ep, a.model, a.key, messages, opts).catch((err: unknown) => {
          if (err instanceof LLMEmptyError) return this.request(ep, a.model, a.key, messages, opts);
          throw err;
        });
        this.cooldown.delete(a.slot);
        return out;
      } catch (err) {
        lastErr = err;
        const status = err instanceof LLMHttpError ? err.status : 0;
        const rest = [401, 402, 403].includes(status) ? 10 * 60_000 : status === 429 || status === 404 ? 60_000 : 0;
        if (rest) this.cooldown.set(a.slot, Date.now() + rest);
        const keyName = a.key === ep.apiKey ? 'key utama' : 'key cadangan';
        console.warn(`[llm] ${a.model} (${keyName}) gagal: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      }
    }
    throw lastErr;
  }

  static fromConfig(config: Config): OpenRouterProvider {
    const { text, vision, jsonMode, timeoutMs, providerSort, dataCollection } = config.llm;
    return new OpenRouterProvider(text, vision, jsonMode, timeoutMs, providerSort, dataCollection);
  }

  usage(): LLMUsage {
    return { ...this.stats };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    return this.complete(this.text, messages, opts);
  }

  async vision(prompt: string, image: { data: Uint8Array; mimeType: string }, opts: ChatOptions = {}): Promise<string> {
    if (!this.visionEp.apiKey && !this.visionEp.backupApiKey) throw new Error('LLM vision tidak dikonfigurasi');
    const dataUrl = `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`;
    const messages: WireMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];
    return this.complete(this.visionEp, messages, opts);
  }

  private async request(ep: LLMEndpoint, model: string, apiKey: string, messages: WireMessage[], opts: ChatOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      // Model "reasoning" (mis. beberapa model gratis) menghabiskan token untuk berpikir dulu;
      // batas terlalu kecil → jawaban kosong. Hanya batas atas, bukan yang ditagih.
      max_tokens: Math.max(opts.maxTokens ?? 800, MIN_MAX_TOKENS),
    };
    if (opts.json && this.jsonMode) body.response_format = { type: 'json_object' };
    // Field khusus OpenRouter; endpoint lain (Hermes lokal) tidak dikirimi.
    if (new URL(ep.baseUrl).hostname.endsWith('openrouter.ai')) {
      body.provider = { ...(this.providerSort ? { sort: this.providerSort } : {}), ...(this.dataCollection === 'deny' ? { data_collection: 'deny' } : {}) };
      body.usage = { include: true }; // minta biaya per panggilan (usage.cost)
    }
    const started = Date.now();

    const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/mic-bot-akuntabilitas',
        'X-Title': 'MIC Bot Akuntabilitas Kelas',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as CompletionResponse;
    if (!res.ok) throw new LLMHttpError(res.status, `LLM HTTP ${res.status}: ${data.error?.message ?? res.statusText}`);

    this.stats.calls += 1;
    this.stats.promptTokens += data.usage?.prompt_tokens ?? 0;
    this.stats.completionTokens += data.usage?.completion_tokens ?? 0;
    try {
      this.usageSink?.({
        model,
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
        ms: Date.now() - started,
      });
    } catch {
      // log biaya tidak boleh menggagalkan jawaban
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new LLMEmptyError();
    return content;
  }
}
