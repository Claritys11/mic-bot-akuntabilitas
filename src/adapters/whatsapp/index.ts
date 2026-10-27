import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
  type proto,
} from 'baileys';
import { mkdir, rm } from 'node:fs/promises';
import { COMMANDS } from '../../core/commands.ts';
import { addMissingMembers, groupsOfMember } from '../../core/groups.ts';
import type { Core } from '../../core/index.ts';
import type { Attachment, Context, IncomingMessage, Member, MessageBody, OutgoingMessage, Reply, Sender } from '../../core/types.ts';
import { MemberModel, WaPromptModel, type WaPromptDoc } from '../../db/models.ts';
import { helpText, jidUser, matchChoice, parseCommand, parseFormReply, renderBodyWa, renderFormWa } from './format.ts';

// Adapter WhatsApp lewat Baileys (WhatsApp Web multi-device, tidak resmi).
// Satu grup WhatsApp = satu kelas: groupId = channelId = JID grup. Chat pribadi ke bot dipetakan ke
// kelas tempat pengirim terdaftar (lihat IncomingMessage.isDirect).

type SocketConfig = Parameters<typeof makeWASocket>[0];
type Logger = NonNullable<SocketConfig['logger']>;

/** Log Baileys sangat ramai; tampilkan peringatan & error saja. */
function makeLogger(): Logger {
  const noop = () => undefined;
  const logger: Logger = {
    level: 'warn',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: (obj, msg) => console.warn('[whatsapp]', msg ?? '', typeof obj === 'object' ? '' : obj),
    error: (obj, msg) => console.error('[whatsapp]', msg ?? '', obj instanceof Error ? obj.message : ''),
  };
  return logger;
}

const PLATFORM = 'whatsapp' as const;
const GROUP_CACHE_MS = 5 * 60_000;
/** Balasan angka tanpa me-reply hanya dihitung untuk pilihan yang baru saja dikirim. */
const LOOSE_CHOICE_MS = 15 * 60_000;
/** Pesan yang tertunda saat bot offline lebih tua dari ini diabaikan (jangan memproses pilihan basi). */
const STALE_MS = 5 * 60_000;
const SEND_GAP_MS = 600;
/** Bukti transfer cukup kecil; tolak berkas besar sebelum diunduh (cegah memori habis). */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** Kode pairing kedaluwarsa → minta baru, tapi dibatasi supaya nomor tidak dianggap spam oleh WhatsApp. */
const MAX_PAIRING_ATTEMPTS = 5;
const ERROR_TEXT = 'Maaf, ada kendala di sisi bot. Coba lagi sebentar ya 🙏';

export interface WhatsAppOptions {
  authDir: string;
  /** Nomor bot (hanya angka, dengan kode negara) — untuk pairing code saat pertama kali login. */
  phoneNumber?: string;
}

export interface WhatsAppAdapter {
  sender: Sender;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const textOf = (c: proto.IMessage | undefined) =>
  c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.documentMessage?.caption ?? c?.videoMessage?.caption ?? '';

const contextInfoOf = (c: proto.IMessage | undefined) =>
  c?.extendedTextMessage?.contextInfo ?? c?.imageMessage?.contextInfo ?? c?.documentMessage?.contextInfo ?? c?.videoMessage?.contextInfo ?? undefined;

const statusCode = (err: unknown) => (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createWhatsAppAdapter(core: Core, opts: WhatsAppOptions): WhatsAppAdapter {
  let sock: WASocket | null = null;
  let stopped = false;
  let retries = 0;
  let pairingAttempts = 0;
  let markReady: () => void = () => undefined;
  let ready = new Promise<void>((r) => (markReady = r));

  const groupCache = new Map<string, { meta: GroupMetadata; at: number }>();
  /** Pesan terkirim terakhir: untuk retry Baileys & untuk me-reply pesan pilihan. */
  const sent = new Map<string, WAMessage>();
  /** Nama tampilan yang terlihat dari pesan masuk (pushName), per JID. */
  const names = new Map<string, string>();

  const botIds = () => [sock?.user?.id, sock?.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j!));
  const isBot = (jid: string | null | undefined) => Boolean(jid) && botIds().includes(jidNormalizedUser(jid!));

  const remember = (m: WAMessage | undefined) => {
    if (!m?.key.id) return;
    sent.set(m.key.id, m);
    if (sent.size > 500) sent.delete(sent.keys().next().value!);
  };

  async function meta(groupJid: string): Promise<GroupMetadata | null> {
    const hit = groupCache.get(groupJid);
    if (hit && Date.now() - hit.at < GROUP_CACHE_MS) return hit.meta;
    try {
      const m = await sock!.groupMetadata(groupJid);
      groupCache.set(groupJid, { meta: m, at: Date.now() });
      return m;
    } catch {
      return hit?.meta ?? null;
    }
  }

  const sameUser = (p: { id: string; lid?: string; phoneNumber?: string }, ids: string[]) =>
    [p.id, p.lid, p.phoneNumber].filter(Boolean).some((x) => ids.includes(jidNormalizedUser(x!)));

  async function isAdminIn(groupJid: string, ids: string[]): Promise<boolean> {
    if (!isJidGroup(groupJid)) return false;
    const m = await meta(groupJid);
    return Boolean(m?.participants.find((p) => sameUser(p, ids))?.admin);
  }

  const toMember = (groupId: string, jid: string, name?: string | null): Member => ({
    platform: PLATFORM,
    platformUserId: jid,
    groupId,
    displayName: name || names.get(jid) || `+${jidUser(jid)}`,
  });

  // ---------- Kirim (antre satu per satu, jeda pendek — jangan membanjiri) ----------

  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.catch(() => undefined).then(() => sleep(SEND_GAP_MS));
    return run;
  }

  async function connected(): Promise<WASocket> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('WhatsApp belum terhubung')), 60_000)));
    try {
      await Promise.race([ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return sock!;
  }

  /** Kirim satu body ke chat; simpan pilihan/form supaya balasan angka bisa dikenali. */
  async function sendBody(chatId: string, body: MessageBody, ctx: { groupId: string; quoteId?: string | null }): Promise<WAMessage | undefined> {
    const s = await connected();
    const { text, mentions } = renderBodyWa(body);
    const quoted = ctx.quoteId ? sent.get(ctx.quoteId) : undefined;
    const out = await enqueue(async () => {
      if (body.file) {
        return s.sendMessage(
          chatId,
          { document: Buffer.from(body.file!.content, 'utf8'), fileName: body.file!.name, mimetype: 'text/csv', caption: text || undefined, mentions },
          { quoted },
        );
      }
      return s.sendMessage(chatId, { text: text || '…', mentions }, { quoted });
    });
    remember(out);
    if (out?.key.id && body.actions?.length) {
      await WaPromptModel.create({ chatId, messageId: out.key.id, groupId: ctx.groupId, actions: body.actions.slice(0, 9).map((a) => ({ id: a.id, label: a.label })) });
    }
    return out;
  }

  const groupOfTarget = (chatId: string, fallback?: string) => (isJidGroup(chatId) ? chatId : (fallback ?? chatId));

  const sender: Sender = {
    async send(msg: OutgoingMessage) {
      const to = msg.to;
      if (to.kind === 'channel') {
        await sendBody(to.channelId, msg, { groupId: groupOfTarget(to.channelId), quoteId: to.replyTo });
      } else if (to.kind === 'dm') {
        try {
          await sendBody(to.member.platformUserId, msg, { groupId: to.member.groupId });
        } catch (err) {
          console.warn('[whatsapp] DM gagal, kirim ke grup:', (err as Error).message);
          await sendBody(to.fallbackChannelId, to.fallbackText ? { text: to.fallbackText } : msg, { groupId: groupOfTarget(to.fallbackChannelId, to.member.groupId) });
        }
      } else {
        // Tidak ada thread di WhatsApp → balas pesan jangkarnya di grup.
        await sendBody(to.channelId, { ...msg, text: `🧵 *${to.name}*\n${msg.text ?? ''}` }, { groupId: groupOfTarget(to.channelId), quoteId: to.anchorMessageId });
      }
    },
  };

  /** Terapkan Reply dari core. `chatId` = chat tempat orang membalas; `promptId` = pesan pilihan yang dijawab. */
  async function applyReply(r: Reply, ctx: Context & { chatId: string; replyTo?: string; promptId?: string }) {
    const groupId = ctx.groupId;
    if (r.form) {
      const out = await sendBody(ctx.chatId, { text: renderFormWa(r.form) }, { groupId, quoteId: ctx.replyTo });
      if (out?.key.id) {
        await WaPromptModel.create({
          chatId: ctx.chatId,
          messageId: out.key.id,
          groupId,
          form: { id: r.form.id, title: r.form.title, fields: r.form.fields.map((f) => ({ id: f.id, label: f.label, required: f.required ?? false })) },
        });
      }
    }
    if (r.update) {
      // WhatsApp tidak bisa mengganti tombol → pilihan lama dinonaktifkan, hasilnya dikirim sebagai balasan.
      if (ctx.promptId) await WaPromptModel.updateOne({ chatId: ctx.chatId, messageId: ctx.promptId }, { $set: { actions: [] } });
      if (r.update.text || r.update.card || r.update.actions?.length) await sendBody(ctx.chatId, r.update, { groupId, quoteId: ctx.promptId });
    }
    if (r.reply) {
      if (r.reply.private && isJidGroup(ctx.chatId)) {
        // Tidak ada pesan "hanya kamu yang lihat" di WhatsApp → kirim ke chat pribadi.
        await sender.send({ ...r.reply, to: { kind: 'dm', member: ctx.actor, fallbackChannelId: ctx.chatId } });
      } else {
        await sendBody(ctx.chatId, r.reply, { groupId, quoteId: ctx.replyTo });
      }
    }
    for (const m of r.messages ?? []) await sender.send(m).catch((err) => console.error('[whatsapp] gagal kirim:', (err as Error).message));
  }

  // ---------- Pesan masuk ----------

  async function attachmentsOf(m: WAMessage, c: proto.IMessage | undefined): Promise<Attachment[]> {
    const doc = c?.documentMessage && /^image\/(jpeg|png|webp)$/.test(c.documentMessage.mimetype ?? '') ? c.documentMessage : null;
    const media = c?.imageMessage ?? doc;
    if (!media) return [];
    const size = Number(media.fileLength ?? 0);
    if (size > MAX_MEDIA_BYTES) return [];
    return [
      {
        name: doc ? (doc.fileName ?? 'gambar') : 'gambar.jpg',
        contentType: media.mimetype ?? 'image/jpeg',
        size,
        getData: async () => {
          // fileLength bisa dipalsukan pengirim → batasi juga saat mengunduh.
          const stream = await downloadMediaMessage(m, 'stream', {}, { logger: makeLogger(), reuploadRequest: sock!.updateMediaMessage });
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            total += chunk.length;
            if (total > MAX_MEDIA_BYTES) {
              stream.destroy();
              throw new Error('Gambar terlalu besar (maks 10 MB)');
            }
            chunks.push(chunk);
          }
          return new Uint8Array(Buffer.concat(chunks));
        },
      },
    ];
  }

  /** Cari pesan pilihan/form yang sedang dijawab: lewat reply, atau angka polos untuk pilihan terbaru. */
  async function findPrompt(chatId: string, text: string, quotedId: string | null | undefined): Promise<WaPromptDoc | null> {
    if (quotedId) return WaPromptModel.findOne({ chatId, messageId: quotedId }).lean<WaPromptDoc>();
    if (!/^\s*(?:\d{1,2}\s*[.)]?|[1-9]️?⃣)\s*$/u.test(text)) return null;
    return WaPromptModel.findOne({ chatId, 'actions.0': { $exists: true }, createdAt: { $gte: new Date(Date.now() - LOOSE_CHOICE_MS) } })
      .sort({ createdAt: -1 })
      .lean<WaPromptDoc>();
  }

  async function handleMessage(m: WAMessage) {
    const chatId = m.key.remoteJid;
    if (!chatId || m.key.fromMe || chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return;
    const ts = Number(m.messageTimestamp ?? 0) * 1000;
    if (ts && Date.now() - ts > STALE_MS) return;

    const content = normalizeMessageContent(m.message);
    const text = textOf(content).trim();
    const info = contextInfoOf(content);
    const isGroup = Boolean(isJidGroup(chatId));
    const authorJid = jidNormalizedUser(isGroup ? (m.key.participant ?? '') : chatId);
    const altJid = jidNormalizedUser((isGroup ? m.key.participantAlt : m.key.remoteJidAlt) ?? '');
    if (!authorJid) return;
    if (m.pushName) names.set(authorJid, m.pushName);

    // Kelas yang dimaksud: grup ini, atau (chat pribadi) kelas tempat pengirim terdaftar.
    let groupId = chatId;
    if (!isGroup) {
      // Catatan anggota bisa basi (sudah keluar grup) → pastikan masih peserta grup saat ini.
      const recorded = await groupsOfMember(PLATFORM, [authorJid, altJid]);
      const groups: string[] = [];
      for (const g of recorded) if ((await meta(g))?.participants.some((p) => sameUser(p, [authorJid, altJid]))) groups.push(g);
      if (groups.length !== 1) {
        await sendBody(
          chatId,
          {
            text: groups.length
              ? 'Kamu terdaftar di beberapa kelas 😅 Kirim bukti/pertanyaannya di grup kelasnya aja ya (foto bukti kasih keterangan *kas*).'
              : 'Halo! 👋 Aku MIC-Bot, asisten kelas. Aku belum kenal kamu — pastikan kamu sudah pernah ngobrol di grup kelas yang ada aku-nya, lalu coba lagi.',
          },
          { groupId: chatId, quoteId: null },
        );
        return;
      }
      groupId = groups[0]!;
    }

    const actor = toMember(groupId, authorJid, m.pushName);
    const isAdmin = await isAdminIn(groupId, [authorJid, altJid]);
    const base: Context = { platform: PLATFORM, groupId, channelId: chatId, actor, isAdmin };

    // 1) Jawaban untuk pilihan "balas angka" atau form.
    const prompt = await findPrompt(chatId, text, info?.stanzaId);
    if (prompt) {
      if (prompt.form && info?.stanzaId) {
        const values = parseFormReply(text, prompt.form.fields as { id: string; label: string; required?: boolean }[]);
        if (!values) return void (await sendBody(chatId, { text: 'Formatnya belum kebaca 🙏 Salin baris "Label: isi" dari pesan form lalu ganti isinya.' }, { groupId, quoteId: m.key.id }));
        const r = await core.onForm({ ...base, groupId: prompt.groupId, formId: prompt.form.id!, values, messageId: prompt.messageId });
        await WaPromptModel.deleteOne({ _id: prompt._id });
        return applyReply(r, { ...base, groupId: prompt.groupId, chatId, replyTo: m.key.id ?? undefined });
      }
      const i = matchChoice(text, prompt.actions);
      if (i !== null) {
        const ctx = { ...base, groupId: prompt.groupId, isAdmin: prompt.groupId === groupId ? isAdmin : await isAdminIn(prompt.groupId, [authorJid, altJid]) };
        const r = await core.onAction({ ...ctx, actionId: prompt.actions[i]!.id!, messageId: prompt.messageId });
        return applyReply(r, { ...ctx, chatId, replyTo: m.key.id ?? undefined, promptId: prompt.messageId });
      }
    }

    // 2) Perintah teks ("/janji list", "/bantuan").
    if (/^[/!](bantuan|help|menu)\b/i.test(text)) return void (await sendBody(chatId, { text: helpText(COMMANDS) }, { groupId, quoteId: m.key.id }));
    const mentioned = (info?.mentionedJid ?? []).map((j) => jidNormalizedUser(j)).filter((j) => !isBot(j));
    const cmd = parseCommand(text, COMMANDS, (tok) => (tok.startsWith('@') ? mentioned.find((j) => jidUser(j) === tok.slice(1)) : undefined));
    if (cmd) {
      if ('error' in cmd) return void (await sendBody(chatId, { text: `⚠️ ${cmd.error}` }, { groupId, quoteId: m.key.id }));
      const r = await core.onCommand({ ...base, name: cmd.name, options: cmd.options });
      return applyReply(r, { ...base, chatId, replyTo: m.key.id ?? undefined });
    }

    // 3) Obrolan biasa → core. "@62812…" diganti nama supaya core/LLM melihat nama, bukan nomor.
    const mentions = await Promise.all(mentioned.map(async (j) => toMember(groupId, j, names.get(j) ?? (await MemberModel.findOne({ platform: PLATFORM, groupId, platformUserId: j }).lean())?.displayName)));
    let shown = text;
    for (const mm of mentions) shown = shown.split(`@${jidUser(mm.platformUserId)}`).join(`@${mm.displayName}`);
    const incoming: IncomingMessage = {
      id: m.key.id ?? '',
      platform: PLATFORM,
      groupId,
      channelId: chatId,
      author: actor,
      text: shown,
      mentions,
      mentionsBot: (info?.mentionedJid ?? []).some(isBot) || isBot(info?.participant),
      authorIsAdmin: isAdmin,
      isDirect: !isGroup,
      timestamp: ts ? new Date(ts) : new Date(),
      attachments: await attachmentsOf(m, content),
    };
    if (!incoming.text && !incoming.attachments.length) return;
    const out = await core.onMessage(incoming);
    for (const o of out) await sender.send(o);
  }

  // ---------- Grup: sapa saat masuk, sinkron anggota ----------

  async function membersOf(groupId: string): Promise<Member[]> {
    const m = await meta(groupId);
    if (!m) return [];
    const ids = m.participants.map((p) => jidNormalizedUser(p.id)).filter((j) => !isBot(j));
    const known = await MemberModel.find({ platform: PLATFORM, groupId, platformUserId: { $in: ids } }).lean();
    const nameOf = new Map(known.map((k) => [k.platformUserId, k.displayName]));
    return ids.map((j) => toMember(groupId, j, nameOf.get(j)));
  }

  async function greet(groupId: string) {
    try {
      await addMissingMembers(await membersOf(groupId));
      for (const o of await core.onJoin({ platform: PLATFORM, groupId, channelId: groupId })) await sender.send(o);
    } catch (err) {
      console.error('[whatsapp] gagal menyapa grup:', (err as Error).message);
    }
  }

  core.registerPlatform(PLATFORM, {
    // Tidak ada createChannel: WhatsApp tidak punya channel → wawancara memakai grup ini.
    listMembers: (groupId) => membersOf(groupId),
  });

  // ---------- Koneksi ----------

  async function connect() {
    await mkdir(opts.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
    const logger = makeLogger();
    const s = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('MIC-Bot'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => (key.id ? (sent.get(key.id)?.message ?? undefined) : undefined),
      cachedGroupMetadata: async (jid) => groupCache.get(jid)?.meta,
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);

    let pairingRequested = false;
    s.ev.on('connection.update', async (u) => {
      if (u.qr && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        if (!opts.phoneNumber) {
          console.error('[whatsapp] belum login. Isi WA_PHONE_NUMBER (nomor bot, mis. 6281234567890) di .env lalu jalankan ulang.');
          return;
        }
        try {
          const code = await s.requestPairingCode(opts.phoneNumber);
          console.log(
            `\n[whatsapp] KODE PAIRING: ${code.slice(0, 4)}-${code.slice(4)}\n` +
              '           Di HP nomor bot: WhatsApp → ⋮ / Setelan → Perangkat tertaut → Tautkan perangkat →\n' +
              '           "Tautkan dengan nomor telepon saja" → masukkan kode di atas (berlaku beberapa menit).\n',
          );
        } catch (err) {
          console.error('[whatsapp] gagal minta kode pairing:', (err as Error).message);
        }
      }
      if (u.connection === 'open') {
        retries = 0;
        pairingAttempts = 0;
        markReady();
        console.log(`[whatsapp] online sebagai ${jidUser(s.user?.id ?? '')}`);
        try {
          const groups = await s.groupFetchAllParticipating();
          for (const g of Object.values(groups)) groupCache.set(g.id, { meta: g, at: Date.now() });
          console.log(`[whatsapp] ada di ${Object.keys(groups).length} grup`);
          for (const id of Object.keys(groups)) await greet(id);
        } catch (err) {
          console.error('[whatsapp] gagal membaca daftar grup:', (err as Error).message);
        }
      }
      if (u.connection === 'close') {
        ready = new Promise<void>((r) => (markReady = r));
        const code = statusCode(u.lastDisconnect?.error);
        if (stopped) return;
        if (!state.creds.registered) {
          // Belum pernah login (kode pairing tidak dimasukkan tepat waktu) → sesi setengah jadi dibuang, minta kode baru.
          if (++pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
            console.error(`[whatsapp] kode pairing tidak dipakai ${MAX_PAIRING_ATTEMPTS}x. Jalankan ulang bot saat HP nomor bot sudah siap.`);
            return;
          }
          await rm(opts.authDir, { recursive: true, force: true });
          console.warn(`[whatsapp] kode pairing kedaluwarsa, membuat kode baru (${pairingAttempts}/${MAX_PAIRING_ATTEMPTS - 1})...`);
          setTimeout(() => void connect().catch((err) => console.error('[whatsapp] gagal menyambung:', err)), 3_000);
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          console.error(`[whatsapp] sesi dikeluarkan dari HP. Hapus folder ${opts.authDir} lalu jalankan ulang untuk pairing lagi.`);
          return;
        }
        const wait = Math.min(60_000, 2_000 * 2 ** retries++);
        console.warn(`[whatsapp] koneksi putus (kode ${code ?? '?'}), sambung lagi dalam ${wait / 1000} dtk`);
        setTimeout(() => void connect().catch((err) => console.error('[whatsapp] gagal menyambung:', err)), wait);
      }
    });

    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        void handleMessage(m).catch(async (err) => {
          console.error('[whatsapp] gagal memproses pesan:', err);
          if (m.key.remoteJid) await sendBody(m.key.remoteJid, { text: ERROR_TEXT }, { groupId: m.key.remoteJid, quoteId: null }).catch(() => undefined);
        });
      }
    });

    // Dimasukkan ke grup baru → sapa & mulai wawancara setup.
    s.ev.on('groups.upsert', (metas) => {
      for (const g of metas) {
        groupCache.set(g.id, { meta: g, at: Date.now() });
        void greet(g.id);
      }
    });

    s.ev.on('group-participants.update', (ev) => {
      groupCache.delete(ev.id);
      const ids = ev.participants.map((p) => jidNormalizedUser(p.id));
      if (ev.action === 'remove') {
        // Keluar/dikeluarkan → tidak lagi ditagih kas & tidak bisa memakai chat pribadi untuk kelas ini.
        void MemberModel.updateMany({ platform: PLATFORM, groupId: ev.id, platformUserId: { $in: ids } }, { $set: { active: false } }).catch(() => undefined);
        return;
      }
      if (ev.action !== 'add') return;
      if (ids.some(isBot)) void greet(ev.id);
      else void addMissingMembers(ids.map((j) => toMember(ev.id, j))).catch(() => undefined);
    });
  }

  return {
    sender,
    start: async () => {
      if (opts.phoneNumber && !/^\d{8,15}$/.test(opts.phoneNumber)) throw new Error('WA_PHONE_NUMBER harus angka saja dengan kode negara, mis. 6281234567890');
      await connect();
    },
    stop: async () => {
      stopped = true;
      sock?.end(undefined);
    },
  };
}
