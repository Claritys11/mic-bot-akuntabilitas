import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageCreateOptions,
} from 'discord.js';
import { renderTokens, type Action, type ActionKind, type Form, type MessageBody, type Tone } from '../../core/types.ts';

const TONE_COLOR: Record<Tone, number> = {
  info: 0x5865f2,
  success: 0x2ecc71,
  warn: 0xf1c40f,
  danger: 0xe74c3c,
};

const STYLE: Record<ActionKind, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderText(text: string): { text: string; users: string[] } {
  const users: string[] = [];
  const out = renderTokens(text, {
    user: (id) => {
      // Discord menolak seluruh pesan kalau allowed_mentions.users berisi ID ganda.
      if (!users.includes(id)) users.push(id);
      return `<@${id}>`;
    },
    channel: (id) => `<#${id}>`,
  });
  return { text: out, users };
}

const plain = (s: string) => renderText(s).text;

export function renderButtons(actions: Action[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  actions.slice(0, 25).forEach((a, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    rows[rows.length - 1]!.addComponents(new ButtonBuilder().setCustomId(a.id).setLabel(cut(a.label, 80)).setStyle(STYLE[a.kind]));
  });
  return rows;
}

/** MessageBody netral → payload discord.js (dipakai untuk send, reply, update). */
export function renderBody(body: MessageBody) {
  const { text, users } = renderText(body.text ?? '');
  const embeds: EmbedBuilder[] = [];
  if (body.card) {
    const c = body.card;
    const e = new EmbedBuilder().setTitle(cut(plain(c.title), 256)).setColor(TONE_COLOR[c.tone ?? 'info']);
    if (c.description) e.setDescription(cut(plain(c.description), 4000));
    if (c.fields?.length) {
      e.addFields(c.fields.slice(0, 25).map((f) => ({ name: cut(plain(f.name), 256), value: cut(plain(f.value) || '—', 1024), inline: f.inline ?? false })));
    }
    if (c.footer) e.setFooter({ text: cut(plain(c.footer), 2048) });
    embeds.push(e);
  }
  const files = body.file ? [new AttachmentBuilder(Buffer.from(body.file.content, 'utf8'), { name: body.file.name })] : [];
  return {
    content: text ? cut(text, 2000) : undefined,
    embeds,
    components: body.actions ? renderButtons(body.actions) : undefined,
    files,
    // Hanya ping user yang memang disebut lewat token; jangan pernah @everyone.
    allowedMentions: { users, parse: [] as never[] },
  } satisfies MessageCreateOptions;
}

export function renderModal(form: Form): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(form.id).setTitle(cut(form.title, 45));
  for (const f of form.fields.slice(0, 5)) {
    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(cut(f.label, 45))
      .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(f.required ?? false);
    if (f.value) input.setValue(cut(f.value, 4000));
    if (f.placeholder) input.setPlaceholder(cut(f.placeholder, 100));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}
