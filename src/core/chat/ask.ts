import { z } from 'zod';
import { OpportunityModel, PromiseModel, ReminderModel, type GroupDoc, type PromiseDoc, type ReminderDoc } from '../../db/models.ts';
import { askPrompt } from '../../llm/prompts/ask.ts';
import { chatJson, type LLMProvider } from '../../llm/provider.ts';
import { listMembers } from '../groups.ts';
import { paidStatus, periodKey, periodLabel, rupiah, type KasPeriod } from '../kas/ledger.ts';
import { ledgerEntries, rateOf } from '../kas/service.ts';
import { visibleTo } from '../opps/sources.ts';
import { formatWIB, now } from '../time.ts';
import { sanitize, type IncomingMessage, type OutgoingMessage, type SpeechLevel } from '../types.ts';
import { asTranscript, recentChat } from './context.ts';
import { detectMood, graverMood, tidyReply, type Mood } from './mood.ts';

// Bot ikut menjawab saat ditanya ("ada tugas gak nih?", "kas aku udah lunas?") atau di-tag.
// Jawaban hanya dari data yang tercatat; LLM cuma merangkai kalimatnya.

type Topic = 'tugas' | 'kas' | 'lomba' | 'pengingat';

const TOPICS: Record<Topic, RegExp> = {
  tugas: /\b(tugas\w*|pr|deadline\w*|dl|janji\w*|kerjaan\w*|garapan\w*|to ?do|tanggungan)\b/i,
  kas: /\b(kas|iuran|bayar\w*|lunas|tagihan|nunggak|utang)\b/i,
  lomba: /\b(lomba|kompetisi|beasiswa|event|olimpiade)\b/i,
  pengingat: /\b(pengingat\w*|reminder\w*|diingetin|diingatkan|alarm)\b/i,
};
// Kata tanya kuat cukup sendirian; kata lemah ("udah", "ada") butuh partikel tanya di akhir
// supaya "tugasnya udah aku kirim" tidak dianggap pertanyaan.
// Termasuk bahasa Jawa ngoko/krama (opo/piye/menapa/wonten…), karena tingkat tutur grup bisa krama.
const STRONG_Q = /\b(apa|apaan|berapa|kapan|siapa|gimana|bagaimana|mana|opo|piye|sopo|endi|pira|menapa|pinten|sinten|pundi)\b/i;
const WEAK_Q = /\b(ada|udah|sudah|belum|blm|ono|onok|wis|durung|wonten|sampun|dereng)\b/i;
const QUESTION_TAIL = /\b(gak|ga|nggak|ngga|enggak|engga|belum|blm|kah|nih|ya|yak|kan|sih|gk|ora|durung|mboten|dereng|nggih|to|ta)\s*[.!~]*$/i;

export function topicsOf(text: string): Topic[] {
  return (Object.keys(TOPICS) as Topic[]).filter((t) => TOPICS[t].test(text));
}

/** Pertanyaan soal tugas/kas/lomba yang layak dijawab bot walau tidak di-tag. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 4 || t.length > 300 || !topicsOf(t).length) return false;
  if (t.includes('?')) return true;
  return STRONG_Q.test(t) || (WEAK_Q.test(t) && QUESTION_TAIL.test(t));
}

// Jangan nyerobot terus: pertanyaan tanpa tag dijawab maks sekali per menit per channel.
const UNSOLICITED_GAP_MS = 60_000;
const lastUnsolicited = new Map<string, number>();

const AnswerSchema = z.object({
  mood: z.enum(['santai', 'serius', 'tegang', 'sedih']).nullish().catch(null),
  reply: z.string().nullish(),
});

interface PromiseFact {
  tugas: string;
  pemilik: string;
  deadline: string | null;
  lewat: boolean;
  punyaPenanya: boolean;
}

interface ReminderFact {
  isi: string;
  waktu: string;
  untuk: 'kelas' | 'kamu';
}

async function gatherFacts(msg: IncomingMessage, group: GroupDoc, topics: Topic[]) {
  const at = now();
  const all = topics.length === 0;
  const facts: Record<string, unknown> = { kelas: group.className, sekarang: formatWIB(at), penanya: msg.author.displayName };

  if (all || topics.includes('tugas')) {
    const rows = await PromiseModel.find({ groupId: msg.groupId, status: { $in: ['active', 'overdue'] } })
      .sort({ deadline: 1 })
      .limit(15)
      .lean<PromiseDoc[]>();
    facts.janji = rows.map(
      (p): PromiseFact => ({
        tugas: p.task,
        pemilik: p.owner.displayName,
        deadline: p.deadline ? formatWIB(p.deadline) : null,
        lewat: p.status === 'overdue',
        punyaPenanya: p.owner.platformUserId === msg.author.platformUserId,
      }),
    );
    facts.janjiMenungguKonfirmasi = await PromiseModel.countDocuments({ groupId: msg.groupId, status: 'pending_confirm' });
  }

  if ((all || topics.includes('kas')) && group.kas?.amount) {
    const period = periodKey(at, group.kas.period as KasPeriod);
    const [members, entries] = await Promise.all([listMembers(msg.platform, msg.groupId), ledgerEntries(msg.groupId)]);
    const status = paidStatus(
      members.map((m) => ({ id: m.platformUserId, name: m.displayName })),
      entries,
      rateOf(group),
      period,
    );
    const mine = [...status.paid, ...status.unpaid].find((s) => s.id === msg.author.platformUserId);
    facts.kas = {
      iuran: rupiah(group.kas.amount),
      periode: periodLabel(period),
      penanyaSudahBayar: mine ? mine.paidAmount >= group.kas.amount : false,
      penanyaTercatat: rupiah(mine?.paidAmount ?? 0),
      jumlahSudah: status.paid.length,
      jumlahBelum: status.unpaid.length,
      saldo: rupiah(entries.reduce((s, e) => s + e.amount, 0)),
      kirimBuktiDi: group.kasChannelId ? 'channel kas' : 'belum ada channel kas',
    };
  } else if (topics.includes('kas')) {
    facts.kas = 'kas kelas belum diatur';
  }

  if (topics.includes('pengingat')) {
    // Pengingat pribadi orang lain tidak pernah ikut. Milik penanya sendiri dirinci hanya di chat pribadi —
    // di channel grup cukup jumlahnya, karena isinya bisa pribadi ("minum obat").
    const active = { groupId: msg.groupId, sentAt: null, cancelled: false, offered: { $ne: true }, at: { $gt: at } };
    const mine = { 'member.platformUserId': msg.author.platformUserId, target: 'self' as const };
    const [rows, privateCount] = await Promise.all([
      ReminderModel.find({ ...active, $or: [{ target: 'group' }, ...(msg.isDirect ? [mine] : [])] })
        .sort({ at: 1 })
        .limit(10)
        .lean<ReminderDoc[]>(),
      msg.isDirect ? 0 : ReminderModel.countDocuments({ ...active, ...mine }),
    ]);
    facts.pengingat = rows.map((r): ReminderFact => ({ isi: r.what, waktu: formatWIB(r.at), untuk: r.target === 'group' ? 'kelas' : 'kamu' }));
    if (privateCount) facts.pengingatPribadiPenanya = privateCount;
  }

  if (topics.includes('lomba')) {
    const opps = (await OpportunityModel.find({ deadline: { $gt: at }, groupId: { $in: [null, msg.groupId] }, draft: { $ne: true } }).sort({ deadline: 1 }).limit(30).lean())
      .filter((o) => visibleTo(group, o))
      .slice(0, 3);
    facts.lomba = opps.map((o) => ({ judul: o.title, penyelenggara: o.organizer, deadline: formatWIB(o.deadline, 'date') }));
  }
  return facts;
}

/** Jawaban cadangan tanpa LLM (atau kalau LLM gagal) — tetap dari data, tetap singkat. */
export function fallbackAnswer(facts: Record<string, unknown>, topics: Topic[], level: SpeechLevel, addressed: boolean): string | null {
  const s = level === 'santai';
  const parts: string[] = [];
  const janji = facts.janji as PromiseFact[] | undefined;
  if (janji) {
    if (!janji.length) parts.push(s ? 'belum ada tugas yang ku catat nih.' : 'Belum ada tugas yang tercatat.');
    else {
      const lines = janji.slice(0, 5).map((j) => `• ${j.tugas} — ${j.pemilik}${j.deadline ? ` (${j.deadline})` : ''}${j.lewat ? ' (lewat)' : ''}`);
      const more = janji.length > 5 ? `\n…dan ${janji.length - 5} lagi, cek /janji list` : '';
      parts.push(`${s ? `ada ${janji.length} yang masih jalan:` : `Ada ${janji.length} tugas yang masih berjalan:`}\n${lines.join('\n')}${more}`);
    }
  }
  const kas = facts.kas as { iuran: string; periode: string; penanyaSudahBayar: boolean } | string | undefined;
  if (typeof kas === 'string') parts.push(s ? 'kas kelas belum diatur.' : 'Kas kelas belum diatur.');
  else if (kas && topics.includes('kas')) {
    parts.push(
      kas.penanyaSudahBayar
        ? s ? `kas ${kas.periode} kamu udah lunas 👍` : `Kas ${kas.periode} kamu sudah lunas.`
        : s ? `kas ${kas.periode} kamu belum masuk catatan, ${kas.iuran} ya.` : `Kas ${kas.periode} kamu belum tercatat (${kas.iuran}).`,
    );
  }
  const pengingat = facts.pengingat as ReminderFact[] | undefined;
  const pribadi = facts.pengingatPribadiPenanya as number | undefined;
  if (pengingat) {
    if (pribadi) parts.push(s ? `kamu punya ${pribadi} pengingat pribadi — isinya nggak ku sebut di sini, nanti ku kirim pas waktunya.` : `Anda punya ${pribadi} pengingat pribadi; isinya tidak saya sebut di sini.`);
    if (!pengingat.length && !pribadi) parts.push(s ? 'belum ada pengingat yang aktif buat kamu.' : 'Belum ada pengingat aktif untuk Anda.');
    else if (pengingat.length) parts.push(`${s ? 'pengingat yang aktif:' : 'Pengingat yang aktif:'}\n${pengingat.slice(0, 5).map((p) => `• ${p.isi} (${p.waktu})${p.untuk === 'kelas' ? ' — buat kelas' : ''}`).join('\n')}`);
  }
  const lomba = facts.lomba as { judul: string; deadline: string }[] | undefined;
  if (lomba) parts.push(lomba.length ? lomba.map((l) => `• ${l.judul} (s.d. ${l.deadline})`).join('\n') : s ? 'belum ada info lomba yang buka.' : 'Belum ada info lomba yang buka.');
  if (parts.length) return parts.join('\n');
  return addressed ? (s ? 'hadir 👋 mau cek tugas, kas, atau info lomba?' : 'Halo, ada yang bisa saya bantu? Bisa cek tugas, kas, atau info lomba.') : null;
}

/**
 * Jawab kalau bot di-tag atau ada pertanyaan soal tugas/kas/lomba. [] kalau tidak perlu nimbrung.
 */
export async function answerQuestion(llm: LLMProvider, msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[]> {
  const addressed = Boolean(msg.mentionsBot);
  if (!addressed && !looksLikeQuestion(msg.text)) return [];
  const key = `${msg.groupId}:${msg.channelId}`;
  if (!addressed && Date.now() - (lastUnsolicited.get(key) ?? 0) < UNSOLICITED_GAP_MS) return [];

  const topics = topicsOf(msg.text);
  const level = group.speechLevel as SpeechLevel;
  const recent = await recentChat(msg.groupId, msg.channelId, msg.timestamp);
  let mood: Mood = detectMood([...recent.map((l) => l.text), msg.text]);
  const facts = await gatherFacts(msg, group, addressed && !topics.length ? [] : topics);

  let reply: string | null | undefined;
  let llmSaidSilent = false;
  if (llm.enabled) {
    const out = await chatJson(
      llm,
      AnswerSchema,
      askPrompt({ text: msg.text, authorName: msg.author.displayName, addressedToBot: addressed, speechLevel: level, moodHint: mood, recent: asTranscript(recent), facts }),
      { maxTokens: 500, temperature: 0.6 },
    );
    if (out) {
      mood = graverMood(mood, out.mood);
      reply = out.reply;
      llmSaidSilent = !addressed && !out.reply;
    }
  }
  if (llmSaidSilent) return [];
  const clean = reply ? cleanAnswer(reply) : null;
  const text = clean ?? fallbackAnswer(facts, topics, level, addressed);
  if (!text) return [];
  if (!addressed) lastUnsolicited.set(key, Date.now());
  return [{ to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id }, text: tidyReply(text, mood) }];
}

/** Rapikan jawaban LLM: tanpa mention massal / link / token mention, panjang wajar. */
function cleanAnswer(reply: string): string | null {
  const t = sanitize(reply).replace(/@(everyone|here)/gi, '$1').replace(/<[@#][!&]?\d+>/g, '').trim();
  if (t.length < 2 || /https?:\/\//i.test(t)) return null;
  return t.length > 1200 ? `${t.slice(0, 1190)}…` : t;
}
