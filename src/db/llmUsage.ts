import type { LLMCallRecord } from '../llm/provider.ts';
import { LlmUsageModel } from './models.ts';

const wibDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

/** Tambahkan satu panggilan ke ringkasan harian. Gagal simpan cukup dicatat di log. */
export function recordLlmCall(r: LLMCallRecord, at = new Date()): void {
  LlmUsageModel.updateOne(
    { day: wibDay(at), model: r.model },
    {
      $inc: {
        calls: 1,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        costUsd: r.costUsd ?? 0,
        unpricedCalls: r.costUsd === null ? 1 : 0,
        totalMs: r.ms,
      },
    },
    { upsert: true },
  ).catch((err: Error) => console.warn('[llm] gagal mencatat biaya:', err.message));
}
