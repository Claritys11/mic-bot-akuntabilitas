// Terjemahan murni (tanpa koneksi) antara tipe core dan teks WhatsApp.
// WhatsApp untuk akun biasa tidak punya tombol/modal/slash command, jadi:
//   Action[]  → daftar "balas angka"      Form → template "Label: isi" yang dibalas
//   Card      → teks tebal + baris •      /kas rekap → CommandInvocation dari teks

import type { CommandSpec, OptionSpec } from '../../core/commands.ts';
import { renderTokens, type Action, type Form, type MessageBody, type OptionValue } from '../../core/types.ts';

/** Bagian nomor/ID dari JID, mis. "62812...@s.whatsapp.net" → "62812...". Dipakai untuk teks "@nomor". */
export const jidUser = (jid: string) => jid.split('@')[0]!.split(':')[0]!;

/** Markdown gaya Discord → gaya WhatsApp (*tebal*, _miring_). */
export function toWaMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/__(.+?)__/gs, '_$1_')
    .replace(/^#{1,3}\s+(.+)$/gm, '*$1*');
}

/** Token mention core → "@nomor" + daftar JID yang harus ikut di `mentions` supaya benar-benar nge-tag. */
export function renderTextWa(text: string): { text: string; mentions: string[] } {
  const mentions: string[] = [];
  const out = renderTokens(text, {
    user: (id) => {
      if (!mentions.includes(id)) mentions.push(id);
      return `@${jidUser(id)}`;
    },
    // Di WhatsApp kelas = satu grup; "channel kas" ya grup itu sendiri.
    channel: () => 'grup ini',
  });
  return { text: toWaMarkdown(out), mentions };
}

export const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

export function renderActions(actions: Action[]): string {
  if (!actions.length) return '';
  const lines = actions.slice(0, 9).map((a, i) => `${NUMBER_EMOJI[i]} ${a.label}`);
  return `${lines.join('\n')}\n_Balas pesan ini dengan angkanya._`;
}

/** MessageBody netral → satu teks WhatsApp (teks, kartu, pilihan, berkas dirender terpisah oleh adapter). */
export function renderBodyWa(body: MessageBody): { text: string; mentions: string[] } {
  const parts: string[] = [];
  if (body.text) parts.push(body.text);
  if (body.card) {
    const c = body.card;
    const card: string[] = [`*${c.title}*`];
    if (c.description) card.push(c.description);
    for (const f of c.fields ?? []) card.push(`• *${f.name}:* ${f.value || '—'}`);
    if (c.footer) card.push(`_${c.footer}_`);
    parts.push(card.join('\n'));
  }
  if (body.actions?.length) parts.push(renderActions(body.actions));
  return renderTextWa(parts.join('\n\n'));
}

export function renderFormWa(form: Form): string {
  const lines = form.fields.map((f) => `${f.label}: ${f.value ?? ''}`);
  return (
    `📝 *${form.title}*\n` +
    'Balas pesan ini, salin baris di bawah lalu ganti isinya:\n\n' +
    `${lines.join('\n')}`
  );
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Balasan "Label: isi" → nilai per field. Form satu field boleh dibalas isinya saja. */
export function parseFormReply(text: string, fields: { id: string; label: string; required?: boolean | null }[]): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]{1,60}):\s*(.*)$/);
    if (!m) continue;
    const key = norm(m[1]!);
    const field = fields.find((f) => norm(f.label) === key) ?? fields.find((f) => key.length >= 3 && norm(f.label).startsWith(key));
    if (field) values[field.id] = m[2]!.trim();
  }
  if (!Object.keys(values).length && fields.length === 1 && text.trim()) values[fields[0]!.id] = text.trim();
  if (fields.some((f) => f.required && !values[f.id])) return null;
  return Object.keys(values).length ? values : null;
}

/** "1", "2.", "pilih 2", "1️⃣", atau label persis → indeks pilihan; selain itu null. */
export function matchChoice(text: string, actions: { label?: string | null }[]): number | null {
  const t = text.trim();
  const emoji = NUMBER_EMOJI.findIndex((e) => t.startsWith(e));
  if (emoji >= 0 && emoji < actions.length) return emoji;
  const m = t.match(/^(?:pilih|nomor|no\.?)?\s*(\d{1,2})\s*[.)]?$/i);
  if (m) {
    const i = Number(m[1]) - 1;
    return i >= 0 && i < actions.length ? i : null;
  }
  const n = norm(t);
  if (!n) return null;
  const byLabel = actions.findIndex((a) => a.label && norm(a.label) === n);
  return byLabel >= 0 ? byLabel : null;
}

// ---------- Slash command dari teks ----------

export type ParsedCommand = { name: string; options: Record<string, OptionValue | undefined> } | { error: string };

const TRUE = /^(ya|iya|y|yes|true|1|on)$/i;
const FALSE = /^(tidak|nggak|ga|gak|no|n|false|0|off)$/i;

/** Pecah argumen, menghormati tanda kutip: kelas:"XI RPL 2" → ['kelas:XI RPL 2']. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /(\S+?:)?"([^"]*)"|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[2] !== undefined ? `${m[1] ?? ''}${m[2]}` : m[3]!);
  return out;
}

function coerce(o: OptionSpec, raw: string, resolveUser: (token: string) => string | undefined): OptionValue | undefined | Error {
  switch (o.type) {
    case 'integer': {
      const n = Number(raw.replace(/[.,](?=\d{3}\b)/g, ''));
      return Number.isInteger(n) && n > 0 ? n : new Error(`${o.name} harus angka bulat`);
    }
    case 'boolean':
      return TRUE.test(raw) ? true : FALSE.test(raw) ? false : new Error(`${o.name} isi ya/tidak`);
    case 'user':
      return resolveUser(raw) ?? new Error(`${o.name}: tag orangnya pakai @`);
    case 'channel':
      return undefined; // WhatsApp: selalu grup ini
    case 'string':
      if (o.choices && !o.choices.some((c) => c.value === raw)) return new Error(`${o.name} pilih salah satu: ${o.choices.map((c) => c.value).join(', ')}`);
      return raw;
  }
}

/**
 * "/kas atur 10000 bulanan" atau "/kas atur nominal:10000 periode:bulanan" → CommandInvocation.
 * Mengembalikan null kalau teks bukan perintah yang dikenal (jadi diperlakukan sebagai obrolan biasa).
 */
export function parseCommand(text: string, specs: CommandSpec[], resolveUser: (token: string) => string | undefined = () => undefined): ParsedCommand | null {
  const m = text.trim().match(/^[/!]([\p{L}-]+)(?:\s+([\s\S]*))?$/u);
  if (!m) return null;
  const spec = specs.find((s) => s.name === m[1]!.toLowerCase());
  if (!spec) return null;
  let rest = tokenize(m[2] ?? '');
  let name = spec.name;
  let options = spec.options ?? [];
  if (spec.subcommands?.length) {
    const sub = spec.subcommands.find((s) => s.name === rest[0]?.toLowerCase());
    if (!sub) return { error: `Pilih salah satu: ${spec.subcommands.map((s) => `/${spec.name} ${s.name}`).join(', ')}` };
    name = `${spec.name}.${sub.name}`;
    options = sub.options ?? [];
    rest = rest.slice(1);
  }

  const out: Record<string, OptionValue | undefined> = {};
  const positional: string[] = [];
  for (const tok of rest) {
    const kv = tok.match(/^([a-z_]+)[:=]([\s\S]*)$/i);
    const opt = kv && options.find((o) => o.name === kv[1]!.toLowerCase());
    if (opt) {
      const v = coerce(opt, kv![2]!, resolveUser);
      if (v instanceof Error) return { error: v.message };
      out[opt.name] = v;
    } else positional.push(tok);
  }
  // Sisa kata diisikan berurutan ke opsi yang belum terisi; opsi teks terakhir menampung sisa kalimat.
  const free = options.filter((o) => out[o.name] === undefined && o.type !== 'channel');
  for (let i = 0; i < free.length && positional.length; i++) {
    const o = free[i]!;
    const raw = o.type === 'string' && i === free.length - 1 ? positional.splice(0).join(' ') : positional.shift()!;
    const v = coerce(o, raw, resolveUser);
    if (v instanceof Error) return { error: v.message };
    out[o.name] = v;
  }
  const missing = options.filter((o) => o.required && out[o.name] === undefined);
  if (missing.length) return { error: `Kurang: ${missing.map((o) => o.name).join(', ')}. Contoh: ${usage(spec, name)}` };
  return { name, options: out };
}

function usage(spec: CommandSpec, name: string): string {
  const sub = name.includes('.') ? spec.subcommands?.find((s) => s.name === name.split('.')[1]) : undefined;
  const opts = (sub ? sub.options : spec.options) ?? [];
  return `/${name.replace('.', ' ')} ${opts.filter((o) => o.type !== 'channel').map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ')}`.trim();
}
