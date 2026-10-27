// Tipe netral platform. Adapter (Discord, nanti WhatsApp) menerjemahkan dari/ke tipe ini.

export type Platform = 'discord' | 'whatsapp';
export type SpeechLevel = 'santai' | 'sopan' | 'krama';

export interface Member {
  platform: Platform;
  platformUserId: string;
  groupId: string;
  displayName: string;
}

export interface Attachment {
  name: string;
  contentType?: string;
  size?: number;
  /** Adapter yang tahu cara mengambil byte-nya (URL CDN Discord, media WA, dll). */
  getData: () => Promise<Uint8Array>;
}

export interface IncomingMessage {
  id: string;
  platform: Platform;
  groupId: string;
  channelId: string;
  author: Member;
  text: string;
  attachments: Attachment[];
  mentions: Member[];
  /** Bot disebut/di-tag di pesan ini. */
  mentionsBot?: boolean;
  /** Pengirim admin grup (untuk wawancara setup). */
  authorIsAdmin?: boolean;
  /**
   * Chat pribadi ke bot (WhatsApp). `groupId` diisi adapter dengan kelas tempat pengirim terdaftar,
   * `channelId` = chat pribadinya. Dipakai untuk kirim bukti kas & tanya status tanpa dilihat grup.
   */
  isDirect?: boolean;
  timestamp: Date;
}

export type ActionKind = 'primary' | 'secondary' | 'success' | 'danger';

/** Tombol netral. Discord merender jadi button, WhatsApp jadi "balas 1/2/3". */
export interface Action {
  id: string;
  label: string;
  kind: ActionKind;
}

export type Tone = 'info' | 'success' | 'warn' | 'danger';

export interface Card {
  title: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
  tone?: Tone;
}

export interface FileOut {
  name: string;
  content: string;
}

export type Target =
  | { kind: 'channel'; channelId: string; replyTo?: string }
  | {
      kind: 'dm';
      member: Member;
      fallbackChannelId: string;
      /**
       * Kalau DM gagal (ditutup), kirim HANYA teks ini ke channel — tanpa isi pesan aslinya.
       * Dipakai untuk pengingat yang tidak boleh terlihat kelas (kas, janji yang belum diakui).
       */
      fallbackText?: string;
    }
  /** Buat (atau pakai) thread dari sebuah pesan, lalu kirim ke dalamnya. */
  | { kind: 'thread'; channelId: string; anchorMessageId: string; name: string };

export interface MessageBody {
  /** Boleh berisi token mention(member) — adapter yang merender jadi ping. */
  text?: string;
  card?: Card;
  actions?: Action[];
  file?: FileOut;
}

export interface OutgoingMessage extends MessageBody {
  to: Target;
}

export interface FormField {
  id: string;
  label: string;
  value?: string;
  placeholder?: string;
  long?: boolean;
  required?: boolean;
}

/** Form isian (Discord: modal). */
export interface Form {
  id: string;
  title: string;
  fields: FormField[];
}

export interface Context {
  platform: Platform;
  groupId: string;
  channelId: string;
  actor: Member;
  /** Admin server / pengurus kelas — diisi adapter dari permission platform. */
  isAdmin: boolean;
}

export interface ActionEvent extends Context {
  actionId: string;
  messageId: string;
}

export interface FormSubmit extends Context {
  formId: string;
  values: Record<string, string>;
  messageId?: string;
}

export type OptionValue = string | number | boolean | Attachment;

export interface CommandInvocation extends Context {
  /** Nama bertingkat, mis. "janji.list", "kas.atur". */
  name: string;
  options: Record<string, OptionValue | undefined>;
}

/** Hasil dari tombol/command/form. Adapter memutuskan cara menampilkannya. */
export interface Reply {
  /** Balasan langsung ke yang menekan / memanggil. */
  reply?: MessageBody & { private?: boolean };
  /** Ganti isi pesan asal tombol (mis. hilangkan tombol setelah dikonfirmasi). */
  update?: MessageBody;
  form?: Form;
  messages?: OutgoingMessage[];
}

/** Bot baru masuk grup / dinyalakan di grup yang belum diatur. */
export interface JoinEvent {
  platform: Platform;
  groupId: string;
  /** Channel untuk menyapa (system channel / channel pertama yang bisa ditulisi). */
  channelId: string;
}

/**
 * Kemampuan opsional platform. Discord bisa membuat channel; WhatsApp tidak —
 * core menyesuaikan alurnya kalau fungsi tidak tersedia.
 */
export interface PlatformOps {
  createChannel?(groupId: string, name: string, topic: string, nearChannelId: string): Promise<string | null>;
  listMembers?(groupId: string): Promise<Member[]>;
}

/** Sisi pengirim yang diimplementasikan adapter; dipakai scheduler. */
export interface Sender {
  send(msg: OutgoingMessage): Promise<void>;
}

const TOKEN_RE = /\{\{([@#])([^}]+)\}\}/g;

export function mention(member: Pick<Member, 'platformUserId'>): string {
  return `{{@${member.platformUserId}}}`;
}

export function channelRef(channelId: string): string {
  return `{{#${channelId}}}`;
}

export function renderTokens(
  text: string,
  render: { user: (platformUserId: string) => string; channel: (channelId: string) => string },
): string {
  return text.replace(TOKEN_RE, (_, kind: string, id: string) => (kind === '@' ? render.user(id) : render.channel(id)));
}

/** Netralkan "{{" di teks dari user/LLM supaya tidak bisa menyelipkan token mention palsu. */
export function sanitize(text: string): string {
  // Sisipkan pemisah setelah SETIAP "{" — mengganti pasangan saja bisa diakali dengan "{{{@id}}".
  return text.replace(/\{/g, '{\u200b');
}

export function memberKey(m: Pick<Member, 'platform' | 'platformUserId'>): string {
  return `${m.platform}:${m.platformUserId}`;
}
