import { z } from 'zod';
import { MessageBufferModel } from '../../db/models.ts';
import { summaryPrompt } from '../../llm/prompts/summary.ts';
import { chatJson, type LLMProvider } from '../../llm/provider.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { formatWIB, now } from '../time.ts';
import type { CommandInvocation, IncomingMessage, Reply } from '../types.ts';

// Pesan mentah hanya disimpan di buffer ber-TTL 48 jam (prinsip privasi), lalu hilang otomatis.

const SummarySchema = z.object({
  ringkas: z.string(),
  keputusan: z.array(z.string()).default([]),
  tugasBaru: z.array(z.string()).default([]),
  infoPenting: z.array(z.string()).default([]),
});

export async function bufferMessage(msg: IncomingMessage): Promise<void> {
  const text = msg.text.trim();
  if (!text) return;
  await MessageBufferModel.create({
    groupId: msg.groupId,
    channelId: msg.channelId,
    authorName: msg.author.displayName,
    text: text.slice(0, 1000),
    createdAt: msg.timestamp,
  });
}

const MAX_TRANSCRIPT_CHARS = 12_000;

export async function rangkum(llm: LLMProvider, cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const hours = Math.min(Math.max(Number(cmd.options.jam ?? 3) || 3, 1), 48);
  // Buffer pakai waktu asli pesan, jadi jendela juga pakai waktu nyata (bukan jam demo).
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await MessageBufferModel.find({ groupId: cmd.groupId, channelId: cmd.channelId, createdAt: { $gte: since } })
    .sort({ createdAt: 1 })
    .lean();
  if (rows.length < 3) return { reply: { text: `Obrolan ${hours} jam terakhir di channel ini masih terlalu sedikit untuk dirangkum.`, private: true } };

  let transcript = rows.map((r) => `[${formatWIB(r.createdAt, 'iso').slice(11)}] ${r.authorName}: ${r.text}`).join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);

  if (!llm.enabled) return { reply: { text: 'Fitur rangkuman butuh LLM. Isi `OPENROUTER_API_KEY` / `LLM_API_KEY` dulu.', private: true } };
  const s = await chatJson(llm, SummarySchema, summaryPrompt(transcript, hours), { maxTokens: 700 });
  if (!s) return { reply: { text: 'Maaf, rangkuman gagal dibuat. Coba lagi sebentar ya.', private: true } };

  const list = (xs: string[]) => (xs.length ? xs.slice(0, 5).map((x) => `• ${x}`).join('\n') : '—');
  return {
    reply: {
      card: {
        title: `🧾 Rangkuman ${hours} jam terakhir`,
        tone: 'info',
        description: s.ringkas,
        fields: [
          { name: '✅ Keputusan', value: list(s.keputusan) },
          { name: '📝 Tugas baru', value: list(s.tugasBaru) },
          { name: '📌 Info penting', value: list(s.infoPenting) },
        ],
        footer: `${rows.length} pesan · diperbarui ${formatWIB(now())} · pesan mentah terhapus otomatis setelah 48 jam`,
      },
    },
  };
}
