import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { GroupModel, MessageBufferModel, PromiseModel, type GroupDoc, type PromiseDoc } from '../../db/models.ts';
import { chatJson, type LLMProvider } from '../../llm/provider.ts';
import { promisePrompt } from '../../llm/prompts/promise.ts';
import { initialStage } from '../billing/escalation.ts';
import { findMemberByName, getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { formatWIB, now } from '../time.ts';
import {
  mention,
  sanitize,
  type Action,
  type ActionEvent,
  type Card,
  type CommandInvocation,
  type Context,
  type Form,
  type FormSubmit,
  type IncomingMessage,
  type Member,
  type OutgoingMessage,
  type Reply,
  type SpeechLevel,
} from '../types.ts';
import { asTranscript, recentChat } from '../chat/context.ts';
import { detectMood, graverMood, type Mood } from '../chat/mood.ts';
import { parseRelativeDate } from './dateParser.ts';
import { heuristicExtract, looksLikePromise, type Extraction } from './prefilter.ts';
import { isRepeatPromise, shouldAutoActivate } from './autoActivate.ts';
import { acceptLlmLine, askLine, autoLine, cancelledLine, confirmedLine, doneLine, LABELS } from './voice.ts';

export const ExtractionSchema = z.object({
  isPromise: z.boolean(),
  task: z.string().default(''),
  ownerName: z.string().nullish(),
  deadlineText: z.string().nullish(),
  confidence: z.number().min(0).max(1).default(0.5),
  mood: z.enum(['santai', 'serius', 'tegang', 'sedih']).nullish().catch(null),
  reply: z.string().nullish(),
});

export const MIN_CONFIDENCE = 0.6;


export const ids = {
  confirm: (id: string) => `p:ok:${id}`,
  edit: (id: string) => `p:edit:${id}`,
  cancel: (id: string) => `p:no:${id}`,
  done: (id: string) => `p:done:${id}`,
  undo: (id: string) => `p:undo:${id}`,
  form: (id: string) => `pf:edit:${id}`,
};

const STATUS_LABEL: Record<string, string> = {
  pending_confirm: '⏳ menunggu konfirmasi',
  active: '🟢 aktif',
  done: '✅ selesai',
  overdue: '🔴 lewat deadline',
  cancelled: '⚪ dibatalkan',
};

const deadlineLabel = (p: Pick<PromiseDoc, 'deadline'>) =>
  p.deadline ? formatWIB(p.deadline) : 'belum ditentukan — klik ✏️ Ubah';

export function promiseCard(p: PromiseDoc, title: string, tone: Card['tone'] = 'info'): Card {
  return {
    title,
    tone,
    fields: [
      { name: 'Tugas', value: p.task },
      { name: 'Pemilik', value: mention(p.owner), inline: true },
      { name: 'Deadline', value: deadlineLabel(p), inline: true },
    ],
    footer: p.status === 'pending_confirm' ? 'Hanya janji yang dikonfirmasi yang akan diingatkan.' : `Status: ${STATUS_LABEL[p.status]}`,
  };
}

export const confirmActions = (id: string, level: SpeechLevel = 'sopan'): Action[] => [
  { id: ids.confirm(id), label: LABELS[level].confirm, kind: 'success' },
  { id: ids.edit(id), label: LABELS[level].edit, kind: 'secondary' },
  { id: ids.cancel(id), label: LABELS[level].cancel, kind: 'danger' },
];

export const doneAction = (id: string, level: SpeechLevel = 'sopan'): Action => ({ id: ids.done(id), label: LABELS[level].done, kind: 'success' });

export const activeActions = (id: string, level: SpeechLevel): Action[] => [
  { id: ids.edit(id), label: LABELS[level].edit, kind: 'secondary' },
  doneAction(id, level),
];

/** Baris kecil di bawah obrolan: apa yang dicatat + deadline hasil tafsiran (biar bisa dikoreksi). */
export const detailLine = (p: Pick<PromiseDoc, 'task' | 'deadline'>) => `_📝 ${p.task} · ⏰ ${deadlineLabel(p)}_`;

/** Selesaikan deadline: hasil parser; kalau lewat dan tanpa jam, geser ke 23:59 hari itu. */
export function resolveDeadline(text: string | null | undefined, at: Date): Date | null {
  if (!text) return null;
  const parsed = parseRelativeDate(text, at);
  if (!parsed) return null;
  let d = parsed.date;
  if (d <= at && !parsed.hasTime) d = new Date(d.getTime() + (3 * 60 + 59) * 60_000);
  return d > at ? d : null;
}

interface ChatScene {
  level: SpeechLevel;
  mood: Mood;
  recent: string[];
}

/** Suasana channel saat ini dari buffer obrolan (dipakai saat tombol diklik, tanpa LLM). */
async function moodNow(groupId: string, channelId: string): Promise<Mood> {
  const lines = await recentChat(groupId, channelId, new Date(), 8);
  return detectMood(lines.map((l) => l.text));
}

async function extract(
  llm: LLMProvider,
  msg: IncomingMessage,
  scene: ChatScene,
): Promise<{ ex: Extraction; mood: Mood; source: 'llm' | 'heuristic' } | null> {
  if (llm.enabled) {
    const ex = await chatJson(
      llm,
      ExtractionSchema,
      promisePrompt({
        text: msg.text,
        authorName: msg.author.displayName,
        mentionNames: msg.mentions.map((m) => m.displayName),
        nowWIB: formatWIB(now()),
        speechLevel: scene.level,
        moodHint: scene.mood,
        recent: scene.recent,
      }),
      { maxTokens: 300 },
    );
    if (ex) {
      const { mood, ...rest } = ex;
      return {
        ex: { ...rest, task: sanitize(ex.task), ownerName: ex.ownerName ?? undefined, deadlineText: ex.deadlineText ?? undefined, reply: ex.reply ? sanitize(ex.reply) : undefined },
        mood: graverMood(scene.mood, mood),
        source: 'llm',
      };
    }
  }
  const ex = heuristicExtract(msg.text);
  return ex ? { ex, mood: scene.mood, source: 'heuristic' } : null;
}

async function resolveOwner(msg: IncomingMessage, ownerName?: string): Promise<Member> {
  if (!ownerName) return msg.author;
  const name = ownerName.replace(/^@/, '').toLowerCase();
  const byMention = msg.mentions.find((m) => m.displayName.toLowerCase().startsWith(name) || name.startsWith(m.displayName.toLowerCase()));
  if (byMention) return byMention;
  if (msg.mentions.length === 1) return msg.mentions[0]!;
  return (await findMemberByName(msg.platform, msg.groupId, ownerName)) ?? msg.author;
}

/** Deteksi janji dari obrolan biasa → pesan konfirmasi dengan tombol. */
export async function detectPromise(llm: LLMProvider, msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[]> {
  if (!looksLikePromise(msg.text)) return [];
  const level = group.speechLevel as SpeechLevel;
  const recent = await recentChat(msg.groupId, msg.channelId, msg.timestamp);
  const mood = detectMood([...recent.map((l) => l.text), msg.text]);
  const result = await extract(llm, msg, { level, mood, recent: asTranscript(recent) });
  if (!result || !result.ex.isPromise || result.ex.confidence < MIN_CONFIDENCE || !result.ex.task.trim()) return [];

  const owner = await resolveOwner(msg, result.ex.ownerName);
  const at = now();
  const deadline = resolveDeadline(result.ex.deadlineText, at) ?? resolveDeadline(msg.text, at);

  // Janji yang diulang ("iya aku yang bikin PPT kok") tidak dicatat dua kali.
  const open = await PromiseModel.find(
    { groupId: msg.groupId, 'owner.platformUserId': owner.platformUserId, status: { $in: ['pending_confirm', 'active', 'overdue'] }, createdAt: { $gte: new Date(at.getTime() - 14 * 86400_000) } },
    { task: 1, deadline: 1 },
  ).lean();
  if (open.some((o) => isRepeatPromise({ task: o.task, deadline: o.deadline ?? null }, { task: result.ex.task, deadline }))) return [];

  const shadow = group.pilotMode === 'diam';
  const auto = shouldAutoActivate({
    source: result.source,
    confidence: result.ex.confidence,
    ownerIsAuthor: owner.platformUserId === msg.author.platformUserId,
    hasDeadline: Boolean(deadline),
  });

  const p = await PromiseModel.create({
    platform: msg.platform,
    groupId: msg.groupId,
    channelId: msg.channelId,
    sourceMessageId: msg.id,
    owner: { platformUserId: owner.platformUserId, displayName: owner.displayName },
    createdBy: { platformUserId: msg.author.platformUserId, displayName: msg.author.displayName },
    task: result.ex.task.trim(),
    deadline,
    deadlineText: result.ex.deadlineText ?? null,
    source: result.source,
    askedAt: at,
    ...(auto ? { status: 'active', confirmedAt: at, stage: initialStage(deadline!, at), autoActivated: true } : {}),
    // Baseline: semua janji yang terdeteksi dicatat aktif tanpa ditanya; tidak pernah ditagih (shadow).
    ...(shadow ? { status: 'active', confirmedAt: at, shadow: true } : {}),
  });
  if (shadow) return [];
  const doc = p.toObject() as PromiseDoc;
  const id = String(doc._id);
  if (auto) {
    return [
      {
        to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id },
        text: `${autoLine(level, mention(owner), result.mood)}\n${detailLine(doc)}`,
        actions: [...activeActions(id, level), { id: ids.cancel(id), label: LABELS[level].notMine, kind: 'secondary' }],
      },
    ];
  }
  return [
    {
      to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id },
      // Nimbrung seperti teman sekelas: kalimat obrolan + detail kecil, tanpa kartu formal.
      text: `${acceptLlmLine(result.ex.reply, mention(owner), result.mood, [owner.displayName, result.ex.ownerName ?? '']) ?? askLine(level, mention(owner), doc.task, result.mood)}\n${detailLine(doc)}`,
      actions: confirmActions(id, level),
    },
  ];
}

// Jawaban ketik untuk pertanyaan "jadi gak?" — orang sering membalas "jadi dong" alih-alih klik tombol.
const YES = /^(?:jadi|iya+|iy|ya+|yoi|yup|yes|ok(?:e+|ay)?|siap|sip|gas(?:s|keun)?|bener|beneran|betul|aman|fix|pasti|inggih|nggih|leres)\b/i;
const NO = /^(?:(?:ga|gak|nggak|ngga|enggak|engga|g|tidak|ora)\s*jadi|bukan(?:\s+janji\w*)?|salah\s+tangkap|batal|ga|gak|nggak|ngga|enggak|engga|tidak|nope|bercanda|canda|skip|mboten|ora)\b/i;
const TYPED_REPLY_WINDOW_MS = 15 * 60_000;
/** "bukan" polos (tanpa reply/tag) hanya dihitung sebentar setelah bot mencatat. */
const PLAIN_NO_WINDOW_MS = 3 * 60_000;
const UNDO_WINDOW_MS = 10 * 60_000;
/** Membalas (reply) pesan bot boleh lebih lama dari jendela biasa. */
const TYPED_REPLY_WINDOW_TAGGED_MS = 60 * 60_000;

/** "jadi dong" → yes, "ga jadi deh" → no, selain itu (atau kalimat panjang) → null. */
export function typedAnswer(text: string): 'yes' | 'no' | null {
  const t = text.trim();
  if (!t || t.length > 60) return null;
  if (NO.test(t)) return 'no';
  return YES.test(t) ? 'yes' : null;
}

/**
 * "jadi dong" / "ga jadi" dari pemilik janji yang baru ditanya → konfirmasi / batalkan tanpa klik.
 * Kalau janji belum punya deadline dan jawabannya menyebut waktu ("jadi, jumat"), deadline ikut diisi.
 * null kalau pesan ini bukan jawaban untuk janji yang menunggu.
 */
export async function handleTypedConfirmation(msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[] | null> {
  const t = msg.text.trim();
  const answer = typedAnswer(t);
  if (!answer) return null;
  const no = answer === 'no';
  const window = msg.mentionsBot ? TYPED_REPLY_WINDOW_TAGGED_MS : TYPED_REPLY_WINDOW_MS;
  const p = await PromiseModel.findOne({
    groupId: msg.groupId,
    channelId: msg.channelId,
    'owner.platformUserId': msg.author.platformUserId,
    status: 'pending_confirm',
    createdAt: { $gte: new Date(Date.now() - window) },
  })
    .sort({ createdAt: -1 })
    .lean<PromiseDoc>();
  if (!p) return handleTypedOnAuto(msg, group, answer);

  const level = group.speechLevel as SpeechLevel;
  const recent = await recentChat(msg.groupId, msg.channelId, msg.timestamp, 8);
  const mood = detectMood([...recent.map((l) => l.text), t]);
  const id = String(p._id);
  const to = { kind: 'channel' as const, channelId: msg.channelId, replyTo: msg.id };

  if (no) {
    const done = await PromiseModel.findOneAndUpdate({ _id: p._id, status: 'pending_confirm' }, { $set: { status: 'cancelled' } });
    return done ? [{ to, text: `${cancelledLine(level, mood)}\n~~${p.task}~~` }] : null;
  }
  const at = now();
  const deadline = p.deadline ?? resolveDeadline(t, at);
  const updated = await PromiseModel.findOneAndUpdate(
    { _id: p._id, status: 'pending_confirm' },
    { $set: { status: 'active', confirmedAt: at, deadline, stage: deadline ? initialStage(deadline, at) : 'none' } },
    { returnDocument: 'after' },
  ).lean<PromiseDoc>();
  if (!updated) return null;
  return [{ to, text: `${confirmedLine(level, mention(p.owner), !!deadline, mood)}\n${detailLine(updated)}`, actions: activeActions(id, level) }];
}

/**
 * Balasan ke pesan bot untuk janji yang auto-aktif: "bukan" → batal, "iya" → pemilik sudah mengakui
 * (ownerTouched, tagihan boleh diumumkan seperti biasa). Hanya kalau membalas/men-tag bot, supaya
 * kata "bukan" di obrolan biasa tidak membatalkan janji.
 */
async function handleTypedOnAuto(msg: IncomingMessage, group: GroupDoc, answer: 'yes' | 'no'): Promise<OutgoingMessage[] | null> {
  if (msg.replyToOther) return null; // membalas orang lain → bukan jawaban untuk bot
  // "bukan" yang diketik biasa (tanpa reply/tag) juga diterima, tapi ketat: pesan pendek, ≤ 3 menit
  // setelah dicatat, dan pesan pertama pemilik sejak itu (temuan QA T5: orang jarang memakai fitur Reply).
  const plain = !msg.mentionsBot;
  if (plain && msg.text.trim().split(/\s+/).length > 3) return null;
  const since = new Date(now().getTime() - (plain ? PLAIN_NO_WINDOW_MS : TYPED_REPLY_WINDOW_TAGGED_MS));
  const p = await PromiseModel.findOne({
    groupId: msg.groupId,
    channelId: msg.channelId,
    'owner.platformUserId': msg.author.platformUserId,
    status: 'active',
    autoActivated: true,
    ownerTouched: false,
    askedAt: { $gte: since },
  })
    .sort({ askedAt: -1 })
    .lean<PromiseDoc>();
  if (!p) return null;
  if (plain) {
    const between = await MessageBufferModel.countDocuments({
      groupId: msg.groupId,
      channelId: msg.channelId,
      authorId: msg.author.platformUserId,
      createdAt: { $gt: p.askedAt!, $lt: msg.timestamp },
    });
    if (between > 0) return null;
  }
  if (answer === 'yes') {
    await PromiseModel.updateOne({ _id: p._id }, { $set: { ownerTouched: true } });
    return [];
  }
  const done = await PromiseModel.findOneAndUpdate({ _id: p._id, status: 'active', ownerTouched: false }, { $set: { status: 'cancelled', cancelledAt: now() } });
  if (!done) return null;
  const mood = detectMood([msg.text]);
  const id = String(p._id);
  return [
    {
      to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id },
      text: `${cancelledLine(group.speechLevel as SpeechLevel, mood)}\n~~${p.task}~~`,
      // "ga jadi" bisa berarti "tugasnya batal", bukan "salah tangkap" → beri jalan balik.
      actions: [{ id: ids.undo(id), label: '↩️ Urungkan', kind: 'secondary' }],
    },
  ];
}

/** Batal tadi keliru → aktifkan lagi (pemilik saja, ≤ 10 menit). */
async function undoCancel(p: PromiseDoc, ev: ActionEvent): Promise<Reply> {
  if (p.owner.platformUserId !== ev.actor.platformUserId) return deny(`Hanya ${p.owner.displayName} yang bisa mengurungkan.`);
  if (p.status !== 'cancelled' || !p.cancelledAt || now().getTime() - p.cancelledAt.getTime() > UNDO_WINDOW_MS) return deny('Sudah tidak bisa diurungkan — tulis lagi janjinya ya.');
  const back = await PromiseModel.findOneAndUpdate(
    { _id: p._id, status: 'cancelled' },
    { $set: { status: 'active', cancelledAt: null, ownerTouched: true } },
    { returnDocument: 'after' },
  ).lean<PromiseDoc>();
  if (!back) return deny('Sudah tidak bisa diurungkan.');
  const level = await getSpeechLevel(p.platform, p.groupId);
  return { update: { text: `${confirmedLine(level, mention(p.owner), Boolean(back.deadline), 'santai')}\n${detailLine(back)}`, actions: activeActions(String(p._id), level) } };
}

/** Buat janji langsung (dipakai fitur lain, mis. "Bentuk tim"). Tetap perlu dikonfirmasi. */
export async function createPendingPromise(input: {
  ctx: Context;
  owner: Member;
  task: string;
  deadline: Date | null;
  source: 'manual' | 'opportunity';
  channelId?: string;
}): Promise<{ card: Card; actions: Action[]; id: string }> {
  const p = await PromiseModel.create({
    platform: input.ctx.platform,
    groupId: input.ctx.groupId,
    channelId: input.channelId ?? input.ctx.channelId,
    owner: { platformUserId: input.owner.platformUserId, displayName: input.owner.displayName },
    createdBy: { platformUserId: input.ctx.actor.platformUserId, displayName: input.ctx.actor.displayName },
    task: input.task,
    deadline: input.deadline,
    source: input.source,
  });
  const doc = p.toObject() as PromiseDoc;
  const id = String(doc._id);
  return { card: promiseCard(doc, '📝 Janji awal tim'), actions: confirmActions(id), id };
}

const canManage = (p: PromiseDoc, ctx: Context) =>
  ctx.isAdmin || p.owner.platformUserId === ctx.actor.platformUserId || p.createdBy.platformUserId === ctx.actor.platformUserId;

const deny = (text: string): Reply => ({ reply: { text, private: true } });

export async function handlePromiseAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, id] = ev.actionId.split(':');
  if (!id || !isValidObjectId(id)) return deny('Janji tidak ditemukan.');
  // Dari DM, groupId kosong (tombol "Sudah selesai" di pesan pribadi) — cek pemilik saja.
  const p = await PromiseModel.findById(id).lean<PromiseDoc>();
  if (!p || (ev.groupId && ev.groupId !== p.groupId)) return deny('Janji tidak ditemukan.');

  if (verb === 'done') {
    if (!ev.isAdmin && p.owner.platformUserId !== ev.actor.platformUserId) return deny(`Hanya ${p.owner.displayName} yang bisa menandai selesai.`);
    if (p.status === 'done') return deny('Janji ini sudah ditandai selesai 👍');
    if (p.status === 'cancelled' || p.status === 'pending_confirm') return deny('Janji ini tidak aktif.');
    const doneAt = now();
    const updated = await PromiseModel.findByIdAndUpdate(id, { $set: { status: 'done', doneAt, ownerTouched: true } }, { returnDocument: 'after' }).lean<PromiseDoc>();
    const late = !!p.deadline && doneAt > p.deadline;
    const [level, mood] = await Promise.all([getSpeechLevel(p.platform, p.groupId), moodNow(p.groupId, p.channelId)]);
    return {
      update: { text: `${doneLine(level, late, mood)}\n${detailLine(updated!)}`, card: undefined, actions: [] },
      messages:
        // Lewat deadline yang diumumkan ke grup → kabari grup juga saat selesai (auto-aktif yang belum diakui tidak pernah diumumkan).
        p.status === 'overdue' && !(p.autoActivated && !p.ownerTouched)
          ? [{ to: { kind: 'channel', channelId: p.channelId }, text: `Kabar baik: **${p.task}** dari ${mention(p.owner)} sudah selesai. Terima kasih 🙏` }]
          : [],
    };
  }

  if (verb === 'undo') return undoCancel(p, ev);

  if (!canManage(p, ev)) return deny(`Hanya ${p.owner.displayName} (atau pengurus kelas) yang bisa mengubah janji ini.`);

  if (verb === 'edit') return { form: editForm(p) };

  const [level, mood] = await Promise.all([getSpeechLevel(p.platform, p.groupId), moodNow(p.groupId, p.channelId)]);
  // "Bukan janjiku" untuk janji auto-aktif yang belum pernah diakui pemiliknya (juga dari DM pengingat).
  if ((verb === 'cancel' || verb === 'no') && p.autoActivated && !p.ownerTouched && (p.status === 'active' || p.status === 'overdue')) {
    if (p.owner.platformUserId !== ev.actor.platformUserId && !ev.isAdmin) return deny(`Hanya ${p.owner.displayName} yang bisa bilang ini bukan janjinya.`);
    const done = await PromiseModel.findOneAndUpdate({ _id: id, ownerTouched: false, status: { $in: ['active', 'overdue'] } }, { $set: { status: 'cancelled' } });
    if (!done) return deny('Janji ini sudah diproses sebelumnya.');
    return { update: { text: `${cancelledLine(level, mood)}\n~~${p.task}~~`, card: undefined, actions: [] } };
  }

  if (p.status !== 'pending_confirm') return deny('Janji ini sudah diproses sebelumnya.');

  if (verb === 'cancel' || verb === 'no') {
    await PromiseModel.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
    return { update: { text: `${cancelledLine(level, mood)}\n~~${p.task}~~`, card: undefined, actions: [] } };
  }

  if (verb === 'ok') {
    // Pembuat boleh ubah/batalkan, tapi hanya pemilik (atau pengurus) yang bisa mengikat dirinya pada janji.
    if (!ev.isAdmin && p.owner.platformUserId !== ev.actor.platformUserId) return deny(`Hanya ${p.owner.displayName} yang bisa mengonfirmasi janji ini.`);
    const confirmedAt = now();
    const stage = p.deadline ? initialStage(p.deadline, confirmedAt) : 'none';
    const updated = await PromiseModel.findByIdAndUpdate(
      id,
      { $set: { status: 'active', confirmedAt, stage } },
      { returnDocument: 'after' },
    ).lean<PromiseDoc>();
    return {
      update: {
        text: `${confirmedLine(level, mention(p.owner), !!p.deadline, mood)}\n${detailLine(updated!)}`,
        card: undefined,
        actions: activeActions(id, level),
      },
    };
  }
  return deny('Aksi tidak dikenal.');
}

function editForm(p: PromiseDoc): Form {
  return {
    id: ids.form(String(p._id)),
    title: 'Ubah janji',
    fields: [
      { id: 'task', label: 'Tugas', value: p.task, required: true },
      {
        id: 'deadline',
        label: 'Deadline (mis. Jumat jam 19)',
        value: p.deadline ? formatWIB(p.deadline, 'iso') : (p.deadlineText ?? ''),
        placeholder: 'Jumat jam 20.00',
        required: false,
      },
    ],
  };
}

function parseDeadlineInput(input: string, at: Date): Date | null {
  const iso = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})[:.](\d{2}))?$/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!, +(iso[4] ?? 20), +(iso[5] ?? 0)) - 7 * 3600_000);
    return d;
  }
  return resolveDeadline(input, at);
}

export async function handlePromiseForm(ev: FormSubmit): Promise<Reply> {
  const id = ev.formId.split(':')[2];
  if (!id || !isValidObjectId(id)) return deny('Janji tidak ditemukan.');
  // Dari DM (tindak lanjut lewat deadline) groupId kosong → cukup cek kepemilikan.
  const p = await PromiseModel.findOne(ev.groupId ? { _id: id, groupId: ev.groupId } : { _id: id }).lean<PromiseDoc>();
  if (!p || !canManage(p, ev)) return deny('Janji tidak ditemukan atau bukan milikmu.');

  const at = now();
  const task = (ev.values.task ?? p.task).trim() || p.task;
  const rawDeadline = (ev.values.deadline ?? '').trim();
  // Kolom deadline dikosongkan = janji tanpa deadline (tanpa pengingat).
  const deadline = rawDeadline ? parseDeadlineInput(rawDeadline, at) : null;
  if (rawDeadline && !deadline) return deny(`Maaf, aku belum paham deadline "${rawDeadline}". Coba "Jumat jam 19" atau "2026-10-30 19:00".`);

  const set: Record<string, unknown> = { task, deadline, deadlineText: rawDeadline || null };
  if (ev.actor.platformUserId === p.owner.platformUserId) set.ownerTouched = true;
  if (p.status === 'active' || p.status === 'overdue') {
    set.stage = deadline ? initialStage(deadline, at) : 'none';
    set.status = 'active';
  }
  const updated = await PromiseModel.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean<PromiseDoc>();
  const pending = updated!.status === 'pending_confirm';
  const [level, mood] = await Promise.all([getSpeechLevel(p.platform, p.groupId), moodNow(p.groupId, p.channelId)]);
  const who = mention(p.owner);
  return {
    update: {
      text: `${pending ? askLine(level, who, updated!.task, mood) : confirmedLine(level, who, !!updated!.deadline, mood)}\n${detailLine(updated!)}`,
      card: undefined,
      actions: pending ? confirmActions(id, level) : activeActions(id, level),
    },
  };
}

// ---------- Slash command ----------

export async function janjiList(cmd: CommandInvocation): Promise<Reply> {
  const mine = cmd.options.punyaku === true;
  const filter: Record<string, unknown> = { groupId: cmd.groupId, status: { $in: ['active', 'overdue'] } };
  if (mine) filter['owner.platformUserId'] = cmd.actor.platformUserId;
  const rows = await PromiseModel.find(filter).sort({ deadline: 1 }).limit(25).lean<PromiseDoc[]>();
  if (!rows.length) return { reply: { text: mine ? 'Kamu tidak punya janji aktif 🎉' : 'Belum ada janji aktif di kelas ini.', private: mine } };
  const lines = rows.map(
    (p, i) => `**${i + 1}.** ${p.task} — ${p.owner.displayName} · ${p.deadline ? formatWIB(p.deadline) : 'tanpa deadline'}${p.status === 'overdue' ? ' · 🔴 lewat' : ''}`,
  );
  return { reply: { card: { title: mine ? '📋 Janjiku' : '📋 Janji aktif kelas', description: lines.join('\n'), tone: 'info' }, private: mine } };
}

export async function janjiSelesai(cmd: CommandInvocation): Promise<Reply> {
  const rows = await PromiseModel.find({
    groupId: cmd.groupId,
    'owner.platformUserId': cmd.actor.platformUserId,
    status: { $in: ['active', 'overdue'] },
  })
    .sort({ deadline: 1 })
    .limit(5)
    .lean<PromiseDoc[]>();
  if (!rows.length) return { reply: { text: 'Kamu tidak punya janji aktif 🎉', private: true } };
  return {
    reply: {
      private: true,
      text: 'Pilih janji yang sudah selesai:',
      actions: rows.map((p) => ({ id: ids.done(String(p._id)), label: `✅ ${p.task}`.slice(0, 80), kind: 'success' as const })),
    },
  };
}

// ---------- Rapor kelas (skor ketepatan janji, level kelas saja) ----------

export interface ClassScore {
  groupId: string;
  className: string;
  kept: number;
  late: number;
  missed: number;
  active: number;
  score: number | null;
}

export async function classScores(platform: string): Promise<ClassScore[]> {
  const t = now();
  const rows = await PromiseModel.aggregate<{ _id: string; kept: number; late: number; missed: number; active: number }>([
    { $match: { platform, status: { $in: ['active', 'done', 'overdue'] } } },
    {
      $group: {
        _id: '$groupId',
        kept: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'done'] }, { $or: [{ $eq: ['$deadline', null] }, { $lte: ['$doneAt', '$deadline'] }] }] }, 1, 0] } },
        late: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'done'] }, { $ne: ['$deadline', null] }, { $gt: ['$doneAt', '$deadline'] }] }, 1, 0] } },
        missed: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'overdue'] }, { $and: [{ $eq: ['$status', 'active'] }, { $ne: ['$deadline', null] }, { $lt: ['$deadline', t] }] }] }, 1, 0] } },
        active: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $or: [{ $eq: ['$deadline', null] }, { $gte: ['$deadline', t] }] }] }, 1, 0] } },
      },
    },
  ]);
  const groups = await GroupModel.find({ platform, groupId: { $in: rows.map((r) => r._id) } }).lean<GroupDoc[]>();
  const names = new Map(groups.map((g) => [g.groupId, g.className]));
  return rows
    .map((r) => {
      const resolved = r.kept + r.late + r.missed;
      return {
        groupId: r._id,
        className: names.get(r._id) ?? 'Kelas',
        kept: r.kept,
        late: r.late,
        missed: r.missed,
        active: r.active,
        score: resolved ? Math.round((r.kept / resolved) * 100) : null,
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

const bar = (pct: number) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

export async function raporKelas(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const scores = await classScores(cmd.platform);
  const mine = scores.find((s) => s.groupId === cmd.groupId);
  if (!mine || mine.score === null) {
    return { reply: { text: `Belum ada janji yang jatuh tempo di ${group.className}. Rapor muncul setelah ada janji yang selesai/lewat deadline.` } };
  }
  const ranked = scores.filter((s) => s.score !== null);
  const rank = ranked.findIndex((s) => s.groupId === cmd.groupId) + 1;
  return {
    reply: {
      card: {
        title: `📊 Rapor ketepatan janji — ${group.className}`,
        tone: mine.score >= 80 ? 'success' : mine.score >= 50 ? 'warn' : 'danger',
        description: `\`${bar(mine.score)}\` **${mine.score}%** janji ditepati tepat waktu`,
        fields: [
          { name: 'Tepat waktu', value: String(mine.kept), inline: true },
          { name: 'Terlambat', value: String(mine.late), inline: true },
          { name: 'Lewat deadline', value: String(mine.missed), inline: true },
          { name: 'Masih berjalan', value: String(mine.active), inline: true },
          { name: 'Peringkat', value: ranked.length > 1 ? `#${rank} dari ${ranked.length} kelas` : 'Satu-satunya kelas terdaftar', inline: true },
        ],
        footer: 'Skor hanya di level kelas — bot tidak membuat peringkat individu.',
      },
    },
  };
}

export async function getSpeechLevel(platform: string, groupId: string): Promise<SpeechLevel> {
  const g = await GroupModel.findOne({ platform, groupId }, { speechLevel: 1 }).lean();
  return (g?.speechLevel as SpeechLevel) ?? 'sopan';
}
