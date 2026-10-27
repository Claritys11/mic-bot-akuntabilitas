import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type SendableChannels,
} from 'discord.js';
import { COMMANDS, type OptionSpec } from '../../core/commands.ts';
import { upsertMembers } from '../../core/groups.ts';
import type { Core } from '../../core/index.ts';
import type { Context, IncomingMessage, Member, OptionValue, OutgoingMessage, Reply, Sender } from '../../core/types.ts';
import { renderBody, renderModal } from './render.ts';

const ADMIN = PermissionFlagsBits.ManageGuild;

const toMember = (guildId: string, userId: string, name: string): Member => ({
  platform: 'discord',
  platformUserId: userId,
  groupId: guildId,
  displayName: name,
});

const displayName = (m: GuildMember | null | undefined, fallback: string) => m?.displayName ?? fallback;

// ---------- Inbound: Discord → core ----------

function toIncoming(msg: Message<true>): IncomingMessage {
  const guildId = msg.guildId;
  const mentions = [...msg.mentions.users.values()]
    .filter((u) => !u.bot)
    .map((u) => toMember(guildId, u.id, displayName(msg.mentions.members?.get(u.id), u.username)));
  // "<@123>" → "@Budi" supaya core/LLM melihat nama, bukan ID.
  const text = msg.content.replace(/<@!?(\d+)>/g, (raw, id: string) => {
    const m = mentions.find((x) => x.platformUserId === id);
    return m ? `@${m.displayName}` : raw;
  });
  return {
    id: msg.id,
    platform: 'discord',
    groupId: guildId,
    channelId: msg.channelId,
    author: toMember(guildId, msg.author.id, displayName(msg.member, msg.author.username)),
    text,
    mentions,
    // Di-tag atau membalas pesan bot sama-sama dianggap ngajak ngobrol.
    mentionsBot: msg.client.user ? msg.mentions.users.has(msg.client.user.id) || msg.mentions.repliedUser?.id === msg.client.user.id : false,
    authorIsAdmin: Boolean(msg.member?.permissions.has(ADMIN)),
    timestamp: msg.createdAt,
    attachments: [...msg.attachments.values()].map((a) => ({
      name: a.name,
      contentType: a.contentType ?? undefined,
      size: a.size,
      getData: async () => {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`Gagal unduh lampiran: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
    })),
  };
}

function contextOf(i: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction): Context {
  const guildId = i.guildId ?? '';
  const member = i.member && 'displayName' in i.member ? (i.member as GuildMember) : null;
  return {
    platform: 'discord',
    groupId: guildId,
    channelId: i.channelId ?? '',
    actor: toMember(guildId, i.user.id, displayName(member, i.user.globalName ?? i.user.username)),
    isAdmin: Boolean(i.memberPermissions?.has(ADMIN)),
  };
}

function commandOptions(i: ChatInputCommandInteraction): Record<string, OptionValue | undefined> {
  const raw = i.options.data[0]?.type === ApplicationCommandOptionType.Subcommand ? (i.options.data[0].options ?? []) : i.options.data;
  const out: Record<string, OptionValue | undefined> = {};
  for (const o of raw) {
    if (o.type === ApplicationCommandOptionType.User) out[o.name] = o.user?.id;
    else if (o.type === ApplicationCommandOptionType.Channel) out[o.name] = o.channel?.id;
    else out[o.name] = o.value as string | number | boolean | undefined;
  }
  return out;
}

// ---------- Registrasi slash command dari spesifikasi netral ----------

function addOption(b: SlashCommandBuilder | SlashCommandSubcommandBuilder, o: OptionSpec) {
  const base = <T extends { setName(n: string): T; setDescription(d: string): T; setRequired(r: boolean): T }>(x: T) =>
    x.setName(o.name).setDescription(o.description).setRequired(o.required ?? false);
  switch (o.type) {
    case 'string':
      b.addStringOption((x) => {
        base(x);
        if (o.choices) x.addChoices(...o.choices);
        return x;
      });
      break;
    case 'integer':
      b.addIntegerOption((x) => base(x).setMinValue(1));
      break;
    case 'boolean':
      b.addBooleanOption((x) => base(x));
      break;
    case 'user':
      b.addUserOption((x) => base(x));
      break;
    case 'channel':
      b.addChannelOption((x) => base(x).addChannelTypes(ChannelType.GuildText));
      break;
  }
}

export function buildSlashCommands() {
  return COMMANDS.map((spec) => {
    const b = new SlashCommandBuilder().setName(spec.name).setDescription(spec.description).setContexts(0);
    if (spec.adminOnly) b.setDefaultMemberPermissions(ADMIN);
    for (const o of spec.options ?? []) addOption(b, o);
    for (const sub of spec.subcommands ?? []) {
      b.addSubcommand((s) => {
        s.setName(sub.name).setDescription(sub.description);
        for (const o of sub.options ?? []) addOption(s, o);
        return s;
      });
    }
    return b.toJSON();
  });
}

/** Daftar per guild (langsung aktif), bukan global yang bisa butuh waktu lama untuk muncul. */
async function registerCommands(token: string, clientId: string, guildId: string) {
  const rest = new REST().setToken(token);
  const body = buildSlashCommands();
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  console.log(`[discord] ${body.length} slash command terdaftar di guild ${guildId}`);
}

// ---------- Outbound: core → Discord ----------

class DiscordSender implements Sender {
  constructor(private readonly client: Client) {}

  private async channel(id: string): Promise<SendableChannels> {
    const ch = await this.client.channels.fetch(id);
    if (!ch || !ch.isSendable()) throw new Error(`Channel ${id} tidak bisa dikirimi pesan`);
    return ch;
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const payload = renderBody(msg);
    const to = msg.to;
    if (to.kind === 'channel') {
      const ch = await this.channel(to.channelId);
      await ch.send(to.replyTo ? { ...payload, reply: { messageReference: to.replyTo, failIfNotExists: false } } : payload);
      return;
    }
    if (to.kind === 'dm') {
      try {
        const user = await this.client.users.fetch(to.member.platformUserId);
        await user.send(payload);
      } catch {
        // DM tertutup → kirim di channel grup sebagai cadangan (versi samaran kalau isinya pribadi).
        const ch = await this.channel(to.fallbackChannelId);
        await ch.send(to.fallbackText ? renderBody({ text: to.fallbackText }) : payload);
      }
      return;
    }
    const parent = await this.client.channels.fetch(to.channelId);
    if (!parent || parent.type !== ChannelType.GuildText) throw new Error('Thread hanya bisa dibuat di text channel');
    const anchor = await parent.messages.fetch(to.anchorMessageId);
    const thread = anchor.thread ?? (await anchor.startThread({ name: to.name, autoArchiveDuration: 10080 }));
    await thread.send(payload);
  }
}

// ---------- Menerapkan Reply ke interaksi ----------

async function applyReply(i: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction, r: Reply, sender: Sender, deferred: boolean) {
  if (r.form && !deferred && !i.isModalSubmit()) {
    await i.showModal(renderModal(r.form));
    return;
  }
  if (r.update && (i.isButton() || (i.isModalSubmit() && i.isFromMessage()))) {
    const payload = { ...renderBody(r.update), files: undefined };
    if (r.update.actions === undefined) delete (payload as { components?: unknown }).components;
    if (r.update.text === '') (payload as { content?: string }).content = '';
    if (deferred) await i.editReply(payload);
    else await i.update(payload);
    if (r.reply) await i.followUp({ ...renderBody(r.reply), flags: MessageFlags.Ephemeral });
  } else if (r.reply) {
    const payload = renderBody(r.reply);
    const isPrivate = r.reply.private ?? false;
    if (deferred && i.isChatInputCommand()) {
      // Command selalu di-defer secara privat; balasan publik dikirim sebagai follow-up.
      if (isPrivate) await i.editReply(payload);
      else {
        await i.followUp(payload);
        await i.deleteReply().catch(() => undefined);
      }
    } else if (deferred) {
      await i.followUp({ ...payload, flags: isPrivate ? MessageFlags.Ephemeral : undefined });
    } else {
      await i.reply({ ...payload, flags: isPrivate ? MessageFlags.Ephemeral : undefined });
    }
  } else if (r.form) {
    await i.followUp({ content: 'Silakan klik tombolnya lagi untuk membuka form.', flags: MessageFlags.Ephemeral });
  } else if (!deferred && !i.replied) {
    if (i.isButton()) await i.deferUpdate();
  }
  for (const m of r.messages ?? []) {
    await sender.send(m).catch((err) => console.error('[discord] gagal kirim:', (err as Error).message));
  }
}

const ERROR_TEXT = 'Maaf, ada kendala di sisi bot. Coba lagi sebentar ya 🙏';

async function onInteraction(core: Core, sender: Sender, i: Interaction) {
  if (i.isChatInputCommand()) {
    if (!i.inGuild()) return void i.reply({ content: 'Pakai perintah ini di server kelas ya.', flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const sub = i.options.getSubcommand(false);
      const name = sub ? `${i.commandName}.${sub}` : i.commandName;
      const r = await core.onCommand({ ...contextOf(i), name, options: commandOptions(i) });
      await applyReply(i, r, sender, true);
      if (name === 'setup' && i.guild && i.memberPermissions?.has(ADMIN)) {
        // Sinkron daftar anggota untuk rekap kas (butuh Server Members Intent).
        const members = await i.guild.members.fetch().catch(() => null);
        if (members) {
          await upsertMembers(members.filter((m) => !m.user.bot).map((m) => toMember(i.guildId, m.id, m.displayName)));
        }
      }
    } catch (err) {
      console.error('[discord] command gagal:', err);
      await i.editReply({ content: ERROR_TEXT }).catch(() => undefined);
    }
    return;
  }

  if (i.isButton() || i.isModalSubmit()) {
    const ctx = contextOf(i);
    const work = i.isButton()
      ? core.onAction({ ...ctx, actionId: i.customId, messageId: i.message.id })
      : core.onForm({
          ...ctx,
          formId: i.customId,
          messageId: i.message?.id,
          values: Object.fromEntries(i.fields.fields.map((f) => [f.customId, 'value' in f ? String(f.value) : ''])),
        });
    // Discord memberi 3 detik; kalau core lambat, defer dulu (form tidak bisa dibuka setelah defer).
    let deferred = false;
    const timer = setTimeout(() => {
      deferred = true;
      (i.isButton() || (i.isModalSubmit() && i.isFromMessage()) ? i.deferUpdate() : i.deferReply({ flags: MessageFlags.Ephemeral })).catch(() => undefined);
    }, 2200);
    try {
      const r = await work;
      clearTimeout(timer);
      await applyReply(i, r, sender, deferred);
    } catch (err) {
      clearTimeout(timer);
      console.error('[discord] interaksi gagal:', err);
      const payload = { content: ERROR_TEXT, flags: MessageFlags.Ephemeral } as const;
      await (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => undefined);
    }
  }
}

// ---------- Kemampuan platform untuk core (wawancara setup) ----------

/** Channel untuk menyapa: system channel kalau bisa ditulisi, kalau tidak channel teks teratas. */
function greetChannel(guild: Guild): string | null {
  const me = guild.members.me;
  const canSend = (ch: { permissionsFor(m: GuildMember): { has(p: bigint[]): boolean } | null }) =>
    Boolean(me && ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]));
  if (guild.systemChannel && canSend(guild.systemChannel)) return guild.systemChannel.id;
  const text = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText && canSend(c))
    .sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0));
  return text.first()?.id ?? null;
}

function platformOps(client: Client) {
  return {
    async createChannel(groupId: string, name: string, topic: string, nearChannelId: string) {
      try {
        const guild = await client.guilds.fetch(groupId);
        const near = await client.channels.fetch(nearChannelId).catch(() => null);
        const parent = near && 'parentId' in near ? near.parentId : null;
        const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
        if (existing) return existing.id;
        const ch = await guild.channels.create({ name, type: ChannelType.GuildText, topic, parent: parent ?? undefined });
        return ch.id;
      } catch (err) {
        console.error(`[discord] gagal bikin channel #${name}:`, (err as Error).message);
        return null;
      }
    },
    async findChannel(groupId: string, names: string[]) {
      const guild = await client.guilds.fetch(groupId);
      const channels = await guild.channels.fetch();
      const hit = channels.find((c) => c?.type === ChannelType.GuildText && names.includes(c.name));
      return hit?.id ?? null;
    },
    async createPrivateChannel(groupId: string, name: string, topic: string, nearChannelId: string, allowUserIds: string[]) {
      try {
        const guild = await client.guilds.fetch(groupId);
        const near = await client.channels.fetch(nearChannelId).catch(() => null);
        const parent = near && 'parentId' in near ? near.parentId : null;
        const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
        const ch = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          topic,
          parent: parent ?? undefined,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: client.user!.id, allow },
            ...[...new Set(allowUserIds)].map((id) => ({ id, allow })),
          ],
        });
        return ch.id;
      } catch (err) {
        console.error(`[discord] gagal bikin channel privat #${name}:`, (err as Error).message);
        return null;
      }
    },
    async isPrivateChannel(groupId: string, channelId: string) {
      const guild = await client.guilds.fetch(groupId);
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (!ch || !('permissionsFor' in ch)) return false;
      return !ch.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
    },
    async listMembers(groupId: string) {
      const guild = await client.guilds.fetch(groupId);
      const members = await guild.members.fetch();
      return [...members.filter((m) => !m.user.bot).values()].map((m) => toMember(groupId, m.id, m.displayName));
    },
  };
}

export interface DiscordAdapter {
  client: Client;
  sender: Sender;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDiscordAdapter(core: Core, opts: { token: string; guildId?: string }): DiscordAdapter {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  const sender = new DiscordSender(client);
  core.registerPlatform('discord', platformOps(client));

  const greet = async (guild: Guild) => {
    const channelId = greetChannel(guild);
    if (!channelId) return console.warn(`[discord] tidak ada channel yang bisa ditulisi di ${guild.name}`);
    try {
      for (const m of await core.onJoin({ platform: 'discord', groupId: guild.id, channelId })) await sender.send(m);
    } catch (err) {
      console.error('[discord] gagal menyapa server baru:', err);
    }
  };

  const register = (clientId: string, guildId: string) =>
    registerCommands(opts.token, clientId, guildId).catch((err) => console.error(`[discord] gagal daftar command di ${guildId}:`, err));

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] online sebagai ${c.user.tag}`);
    const guildIds = opts.guildId ? [opts.guildId] : [...c.guilds.cache.keys()];
    const invite = (guildId?: string) =>
      `https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=309237763152` +
      (guildId ? `&guild_id=${guildId}&disable_guild_select=true` : '');
    if (opts.guildId && !c.guilds.cache.has(opts.guildId)) {
      console.log(`[discord] bot belum ada di server ${opts.guildId}. Undang lewat:\n  ${invite(opts.guildId)}`);
    } else if (!guildIds.length) {
      console.log(`[discord] bot belum ada di server mana pun. Undang lewat:\n  ${invite()}`);
    }
    for (const id of guildIds.filter((g) => c.guilds.cache.has(g))) {
      await register(c.application.id, id);
      await greet(c.guilds.cache.get(id)!); // belum diatur → mulai wawancara (sekali saja)
    }
  });

  // Diundang ke server baru saat bot berjalan → langsung daftarkan command di sana.
  client.on(Events.GuildCreate, (g) => {
    if (opts.guildId && opts.guildId !== g.id) return;
    void register(g.client.application.id, g.id).then(() => greet(g));
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.inGuild()) return;
    try {
      const out = await core.onMessage(toIncoming(msg));
      for (const m of out) await sender.send(m);
    } catch (err) {
      console.error('[discord] gagal memproses pesan:', err);
    }
  });

  client.on(Events.InteractionCreate, (i) => void onInteraction(core, sender, i));

  return {
    client,
    sender,
    start: async () => {
      await client.login(opts.token);
    },
    stop: async () => {
      await client.destroy();
    },
  };
}
