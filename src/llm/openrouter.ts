import type { Config, LLMEndpoint } from '../config.ts';
import type { ChatMessage, ChatOptions, LLMProvider, LLMUsage } from './provider.ts';

// Klien OpenAI-compatible. Default ke OpenRouter, tapi juga dipakai untuk API server
// Hermes Agent (profil terpisah) — cukup ganti LLM_BASE_URL.

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type WireMessage = { role: string; content: string | ContentPart[] };

interface CompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenRouterProvider implements LLMProvider {
  readonly enabled: boolean;
  private stats: LLMUsage = { calls: 0, promptTokens: 0, completionTokens: 0 };

  constructor(
    private readonly text: LLMEndpoint,
    private readonly visionEp: LLMEndpoint,
    private readonly jsonMode: boolean,
    private readonly timeoutMs: number,
  ) {
    this.enabled = Boolean(text.apiKey);
  }

  static fromConfig(config: Config): OpenRouterProvider {
    const { text, vision, jsonMode, timeoutMs } = config.llm;
    return new OpenRouterProvider(text, vision, jsonMode, timeoutMs);
  }

  usage(): LLMUsage {
    return { ...this.stats };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    return this.complete(this.text, messages, opts);
  }

  async vision(prompt: string, image: { data: Uint8Array; mimeType: string }, opts: ChatOptions = {}): Promise<string> {
    if (!this.visionEp.apiKey) throw new Error('LLM vision tidak dikonfigurasi');
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

  private async complete(ep: LLMEndpoint, messages: WireMessage[], opts: ChatOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: ep.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 800,
    };
    if (opts.json && this.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ep.apiKey ?? ''}`,
        'HTTP-Referer': 'https://github.com/mic-bot-akuntabilitas',
        'X-Title': 'MIC Bot Akuntabilitas Kelas',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as CompletionResponse;
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${data.error?.message ?? res.statusText}`);

    this.stats.calls += 1;
    this.stats.promptTokens += data.usage?.prompt_tokens ?? 0;
    this.stats.completionTokens += data.usage?.completion_tokens ?? 0;

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM mengembalikan respons kosong');
    return content;
  }
}
