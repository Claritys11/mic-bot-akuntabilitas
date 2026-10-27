import type { LLMProvider } from '../llm/provider.ts';
import { collectPromiseReminders } from './billing/service.ts';
import { answerQuestion } from './chat/ask.ts';
import { getGroup, setupGroup, upsertMember } from './groups.ts';
import { collectKasReminders, handleKasAction, handleKasForm, handleKasProof, kasAtur, kasEkspor, kasRekap } from './kas/service.ts';
import { handleOnboardingAction, handleOnboardingMessage, onJoin, startOnboarding } from './onboarding/service.ts';
import { collectOppPosts, handleOppAction, lombaList, lombaTambah } from './opps/service.ts';
import { looksLikeKas } from './promises/prefilter.ts';
import { detectPromise, handlePromiseAction, handleTypedConfirmation, handlePromiseForm, janjiList, janjiSelesai, raporKelas } from './promises/service.ts';
import { collectFollowUps, collectNudges, collectWeeklyDigests } from './followup/service.ts';
import { pilotEkspor, pilotMode } from './pilot/service.ts';
import { collectReminders, handleReminderAction, handleReminderRequest, ingetinCommand } from './reminders/service.ts';
import { dataHapusAnggota, dataHapusKelas, dataHapusSaya, handleDataAction } from './privacy/service.ts';
import { bufferMessage, rangkum } from './summary/service.ts';
import { formatWIB, now, timeScale } from './time.ts';
import { channelRef, sanitize, type ActionEvent, type Member, type OptionValue, type CommandInvocation, type FormSubmit, type IncomingMessage, type JoinEvent, type OutgoingMessage, type Platform, type PlatformOps, type Reply, type SpeechLevel } from './types.ts';

export interface Core {
  onMessage(msg: IncomingMessage): Promise<OutgoingMessage[]>;
  onAction(ev: ActionEvent): Promise<Reply>;
  onForm(ev: FormSubmit): Promise<Reply>;
  onCommand(cmd: CommandInvocation): Promise<Reply>;
  /** Bot masuk grup baru / menyala di grup yang belum diatur → mulai wawancara setup. */
  onJoin(ev: JoinEvent): Promise<OutgoingMessage[]>;
  /** Adapter mendaftarkan kemampuan platform (buat channel, daftar anggota). */
  registerPlatform(platform: Platform, ops: PlatformOps): void;
  /** Dipanggil scheduler: kumpulkan semua pesan terjadwal yang jatuh tempo. */
  tick(at?: Date): Promise<OutgoingMessage[]>;
}

const cleanMember = <T extends Member>(m: T): T => ({ ...m, displayName: sanitize(m.displayName) });
const cleanOptions = (o: Record<string, OptionValue | undefined>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? sanitize(v) : v]));

const fail = (text: string): Reply => ({ reply: { text, private: true } });

export function createCore(llm: LLMProvider): Core {
  const platformOps = new Map<Platform, PlatformOps>();
  const opsFor = (p: Platform) => platformOps.get(p) ?? {};

  async function setup(cmd: CommandInvocation): Promise<Reply> {
    if (!cmd.isAdmin) return fail('Hanya pengurus kelas (admin server) yang bisa menjalankan /setup.');
    // Tanpa opsi → wawancara santai di channel ini (cara utama); dengan opsi → cara cepat.
    if (!cmd.options.kelas) {
      const configured = Boolean(await getGroup(cmd.platform, cmd.groupId));
      return { reply: { text: 'Oke, aku mulai wawancaranya di channel ini ya 👇', private: true }, messages: await startOnboarding(cmd.platform, cmd.groupId, cmd.channelId, configured) };
    }
    const tutur = cmd.options.tutur as SpeechLevel | undefined;
    // Cara cepat: hanya opsi yang diisi yang berubah (mis. ganti tutur tanpa menghapus channel kas).
    const g = await setupGroup(cmd, {
      className: String(cmd.options.kelas),
      major: cmd.options.jurusan !== undefined ? String(cmd.options.jurusan) : undefined,
      speechLevel: tutur && ['santai', 'sopan', 'krama'].includes(tutur) ? tutur : undefined,
      mainChannelId: cmd.channelId,
      kasChannelId: cmd.options.channel_kas as string | undefined,
      oppsChannelId: cmd.options.channel_lomba as string | undefined,
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
    'kas.atur': (cmd) => kasAtur(cmd, opsFor(cmd.platform)),
    'kas.rekap': kasRekap,
    'kas.ekspor': kasEkspor,
    rangkum: (cmd) => rangkum(llm, cmd),
    'pilot.mode': pilotMode,
    'pilot.ekspor': pilotEkspor,
    ingetin: ingetinCommand,
    'data.hapus-saya': dataHapusSaya,
    'data.hapus-anggota': dataHapusAnggota,
    'data.hapus-kelas': dataHapusKelas,
    'lomba.list': lombaList,
    'lomba.tambah': lombaTambah,
  };

  return {
    async onMessage(raw) {
      const msg = { ...raw, text: sanitize(raw.text), author: cleanMember(raw.author), mentions: raw.mentions.map(cleanMember) };
      const group = await getGroup(msg.platform, msg.groupId);
      if (msg.isDirect) {
        // Chat pribadi: tidak masuk buffer obrolan grup & tidak dideteksi sebagai janji (privasi).
        if (!group || group.pilotMode === 'jeda') return [];
        if (msg.attachments.length) return handleKasProof(llm, msg, group);
        const remind = await handleReminderRequest(msg, group);
        if (remind) return remind;
        return answerQuestion(llm, { ...msg, mentionsBot: true }, group);
      }
      // Rem darurat: kelas yang dijeda tidak diproses sama sekali (perintah tetap jalan untuk membuka jeda).
      if (group?.pilotMode === 'jeda') return [];
      const onboarding = await handleOnboardingMessage(msg, opsFor(msg.platform), Boolean(group));
      if (onboarding) return onboarding;
      if (!group) return [];
      await Promise.all([upsertMember(msg.author), bufferMessage(msg)]);
      // Mode pilot "diam" (baseline): catat janji tanpa membalas apa pun.
      if (group.pilotMode === 'diam') {
        await detectPromise(llm, msg, group);
        return [];
      }
      // Kalau channel kas = channel utama (WhatsApp: satu grup), hanya foto berketerangan kas yang dibaca —
      // foto/meme biasa tidak dikirim ke LLM.
      const kasHere = msg.channelId === group.kasChannelId && (group.kasChannelId !== group.mainChannelId || looksLikeKas(msg.text));
      if (kasHere && msg.attachments.length) {
        return handleKasProof(llm, msg, group);
      }
      // "@MIC ingetin aku besok jam 7 …" → pengingat pribadi/kelas.
      const remind = await handleReminderRequest(msg, group);
      if (remind) return remind;
      // "jadi dong" untuk janji yang baru ditanya → konfirmasi tanpa klik.
      const typed = await handleTypedConfirmation(msg, group);
      if (typed) return typed;
      // Janji dulu (paling penting dicatat); kalau bukan janji, mungkin pertanyaan / sapaan ke bot.
      const promise = await detectPromise(llm, msg, group);
      if (promise.length) return promise;
      return answerQuestion(llm, msg, group);
    },

    async onAction(raw) {
      const ev = { ...raw, actor: cleanMember(raw.actor) };
      const prefix = ev.actionId.split(':')[0];
      if (prefix === 'p') return handlePromiseAction(ev);
      if (prefix === 'k') return handleKasAction(ev);
      if (prefix === 'o') return handleOppAction(ev);
      if (prefix === 'ob') return handleOnboardingAction(ev, opsFor(ev.platform));
      if (prefix === 'd') return handleDataAction(ev);
      if (prefix === 'r') return handleReminderAction(ev);
      return fail('Tombol ini sudah tidak berlaku.');
    },

    async onForm(raw) {
      const ev = { ...raw, actor: cleanMember(raw.actor), values: Object.fromEntries(Object.entries(raw.values).map(([k, v]) => [k, sanitize(v)])) };
      const prefix = ev.formId.split(':')[0];
      if (prefix === 'pf') return handlePromiseForm(ev);
      if (prefix === 'kf') return handleKasForm(ev);
      return fail('Form tidak dikenal.');
    },

    async onCommand(raw) {
      const cmd = { ...raw, actor: cleanMember(raw.actor), options: cleanOptions(raw.options) };
      const handler = commands[cmd.name];
      return handler ? handler(cmd) : fail(`Perintah ${cmd.name} belum tersedia.`);
    },

    onJoin,

    registerPlatform(platform, ops) {
      platformOps.set(platform, ops);
    },

    async tick(at = now()) {
      const results = await Promise.allSettled([collectPromiseReminders(at), collectKasReminders(at), collectOppPosts(at), collectReminders(at), collectNudges(at), collectFollowUps(at), collectWeeklyDigests(at)]);
      const out: OutgoingMessage[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') out.push(...r.value);
        else console.error('[scheduler] tugas gagal:', r.reason);
      }
      return out;
    },
  };
}
