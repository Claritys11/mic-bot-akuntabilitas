import type { LLMProvider } from '../llm/provider.ts';
import { collectPromiseReminders } from './billing/service.ts';
import { getGroup, setupGroup, upsertMember } from './groups.ts';
import { collectKasReminders, handleKasAction, handleKasForm, handleKasProof, kasAtur, kasEkspor, kasRekap } from './kas/service.ts';
import { collectOppPosts, handleOppAction, lombaList, lombaTambah } from './opps/service.ts';
import { detectPromise, handlePromiseAction, handlePromiseForm, janjiList, janjiSelesai, raporKelas } from './promises/service.ts';
import { bufferMessage, rangkum } from './summary/service.ts';
import { formatWIB, now, timeScale } from './time.ts';
import { channelRef, type ActionEvent, type CommandInvocation, type FormSubmit, type IncomingMessage, type OutgoingMessage, type Reply, type SpeechLevel } from './types.ts';

export interface Core {
  onMessage(msg: IncomingMessage): Promise<OutgoingMessage[]>;
  onAction(ev: ActionEvent): Promise<Reply>;
  onForm(ev: FormSubmit): Promise<Reply>;
  onCommand(cmd: CommandInvocation): Promise<Reply>;
  /** Dipanggil scheduler: kumpulkan semua pesan terjadwal yang jatuh tempo. */
  tick(at?: Date): Promise<OutgoingMessage[]>;
}

const fail = (text: string): Reply => ({ reply: { text, private: true } });

export function createCore(llm: LLMProvider): Core {
  async function setup(cmd: CommandInvocation): Promise<Reply> {
    if (!cmd.isAdmin) return fail('Hanya pengurus kelas (admin server) yang bisa menjalankan /setup.');
    const tutur = String(cmd.options.tutur ?? 'sopan') as SpeechLevel;
    const g = await setupGroup(cmd, {
      className: String(cmd.options.kelas),
      major: String(cmd.options.jurusan),
      speechLevel: ['santai', 'sopan', 'krama'].includes(tutur) ? tutur : 'sopan',
      mainChannelId: cmd.channelId,
      kasChannelId: (cmd.options.channel_kas as string | undefined) ?? null,
      oppsChannelId: (cmd.options.channel_lomba as string | undefined) ?? null,
    });
    return {
      reply: {
        card: {
          title: `✅ ${g.className} siap`,
          tone: 'success',
          fields: [
            { name: 'Jurusan', value: g.major, inline: true },
            { name: 'Tingkat tutur', value: g.speechLevel, inline: true },
            { name: 'Channel utama', value: channelRef(g.mainChannelId), inline: true },
            { name: 'Channel kas', value: g.kasChannelId ? channelRef(g.kasChannelId) : '—', inline: true },
            { name: 'Channel info lomba', value: g.oppsChannelId ? channelRef(g.oppsChannelId) : '—', inline: true },
          ],
          footer: 'Cukup ngobrol seperti biasa — kalau ada yang berjanji ("aku yang bikin PPT, Jumat jadi"), aku minta konfirmasi lalu mengingatkan.',
        },
      },
    };
  }

  const commands: Record<string, (cmd: CommandInvocation) => Promise<Reply>> = {
    ping: async () => ({
      reply: { text: `🏓 Pong! Waktu bot: ${formatWIB(now())}${timeScale() !== 1 ? ` (demo ×${timeScale()})` : ''} · LLM ${llm.enabled ? 'aktif' : 'nonaktif (mode heuristik)'}`, private: true },
    }),
    setup,
    'janji.list': janjiList,
    'janji.selesai': janjiSelesai,
    'rapor-kelas': raporKelas,
    'kas.atur': kasAtur,
    'kas.rekap': kasRekap,
    'kas.ekspor': kasEkspor,
    rangkum: (cmd) => rangkum(llm, cmd),
    'lomba.list': lombaList,
    'lomba.tambah': lombaTambah,
  };

  return {
    async onMessage(msg) {
      const group = await getGroup(msg.platform, msg.groupId);
      if (!group) return [];
      await Promise.all([upsertMember(msg.author), bufferMessage(msg)]);
      if (msg.channelId === group.kasChannelId && msg.attachments.length) {
        return handleKasProof(llm, msg, group);
      }
      return detectPromise(llm, msg, group);
    },

    async onAction(ev) {
      const prefix = ev.actionId.split(':')[0];
      if (prefix === 'p') return handlePromiseAction(ev);
      if (prefix === 'k') return handleKasAction(ev);
      if (prefix === 'o') return handleOppAction(ev);
      return fail('Tombol ini sudah tidak berlaku.');
    },

    async onForm(ev) {
      const prefix = ev.formId.split(':')[0];
      if (prefix === 'pf') return handlePromiseForm(ev);
      if (prefix === 'kf') return handleKasForm(ev);
      return fail('Form tidak dikenal.');
    },

    async onCommand(cmd) {
      const handler = commands[cmd.name];
      return handler ? handler(cmd) : fail(`Perintah ${cmd.name} belum tersedia.`);
    },

    async tick(at = now()) {
      const results = await Promise.allSettled([collectPromiseReminders(at), collectKasReminders(at), collectOppPosts(at)]);
      const out: OutgoingMessage[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') out.push(...r.value);
        else console.error('[scheduler] tugas gagal:', r.reason);
      }
      return out;
    },
  };
}
