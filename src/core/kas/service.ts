import { createHash } from 'node:crypto';
import { isValidObjectId, type InferSchemaType, type Types } from 'mongoose';
import { z } from 'zod';
import { GroupModel, KasProofModel, KasReminderModel, MemberModel, TransactionModel, type GroupDoc } from '../../db/models.ts';
import { kasProofPrompt } from '../../llm/prompts/kasProof.ts';
import { visionJson, type LLMProvider } from '../../llm/provider.ts';
import { kasText, PRIVATE_FALLBACK, type KasStage } from '../billing/templates.ts';
import { getGroup, listMembers, NOT_SETUP_TEXT } from '../groups.ts';
import { formatWIB, now } from '../time.ts';
import {
  channelRef,
  mention,
  sanitize,
  type ActionEvent,
  type Attachment,
  type Card,
  type CommandInvocation,
  type FormSubmit,
  type IncomingMessage,
  type OutgoingMessage,
  type Platform,
  type PlatformOps,
  type Reply,
  type SpeechLevel,
} from '../types.ts';
import { inQuietHours } from '../quiet.ts';
import { audit, memberName } from '../team/audit.ts';
import { can, rolesOf } from '../team/roles.ts';
import { addReviewer, ensureReviewChannel, removeReviewer, saveReviewTarget } from './review.ts';
import { sheetMarker, spreadsheetIdOf, type KasSheetGateway } from './sheet.ts';
import { allocatePayment, nextPeriod, paidStatus, previousPeriod, rateFor, periodKey, periodLabel, periodRange, rupiah, toCsv, type KasPeriod, type LedgerEntry, type Rate } from './ledger.ts';
import { perceptualHash } from './phash.ts';
import { FLAG_TEXT, normalizeRef, verifyProof, type ProofFlag } from './verify.ts';

const ProofSchema = z.object({
  isTransferProof: z.boolean().default(true),
  nominal: z.coerce.number().nullish(),
  tanggal: z.string().nullish(),
  bank: z.string().nullish(),
  pengirim: z.string().nullish(),
  penerima: z.string().nullish(),
  refId: z.string().nullish(),
});

const isImage = (a: Attachment) => (a.contentType ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(a.name);

const ids = {
  approve: (id: string) => `k:ok:${id}`,
  reject: (id: string) => `k:no:${id}`,
  form: (id: string) => `kf:ok:${id}`,
};

/** Screenshot bukti transfer jauh di bawah ini; gambar lebih besar tidak diunduh. */
const MAX_PROOF_BYTES = 10 * 1024 * 1024;

const refHashOf = (ref: string) => createHash('sha256').update(normalizeRef(ref)).digest('hex');

/**
 * Mode "tanpa simpan bukti": setelah ditinjau, detail pribadi di bukti (nama pengirim/penerima, bank,
 * nomor referensi) dihapus. Yang tersisa: nominal, tanggal, hash gambar & hash refId (cek duplikat).
 * Gambar sendiri memang tidak pernah disimpan.
 */
const SCRUB_AFTER_REVIEW = { sender: null, bank: null, recipient: null, refId: null };

/** Admin, bendahara (peran), atau tim inti kas yang terdaftar eksplisit — bukan "siapa pun yang bisa lihat channel". */
/** Iuran per periode untuk kelas ini (riwayat tarif). */
export function rateOf(g: Pick<GroupDoc, 'kas'>): (period: string) => number {
  const current = { amount: g.kas?.amount ?? 0, period: (g.kas?.period ?? 'bulanan') as KasPeriod };
  return (p) => rateFor(g.kas?.rates as Rate[] | undefined, current, p);
}

/** Periode pertama yang ditagih: tarif pertama yang berlaku / saat kas diatur (maks 12 periode ke belakang). */
function billingStart(g: GroupDoc, at: Date): string {
  const kasPeriod = (g.kas?.period ?? 'bulanan') as KasPeriod;
  const current = periodKey(at, kasPeriod);
  let floor = current;
  for (let n = 0; n < 11; n++) floor = previousPeriod(floor, kasPeriod);
  const firstRate = (g.kas?.rates ?? []).find((r) => r.period === kasPeriod && r.from && r.from !== '0000')?.from;
  const since = firstRate ?? (g.kas?.setAt ? periodKey(new Date(g.kas.setAt), kasPeriod) : current);
  return since > floor ? since : floor;
}

/** Simpan alokasi pembayaran (bukti transfer atau tunai) ke buku kas. */
async function recordPayment(g: GroupDoc, input: { platform: string; groupId: string; member: { platformUserId: string; displayName: string }; nominal: number; note: string; proofId?: unknown; actorId: string }) {
  const kasPeriod = (g.kas?.period ?? 'bulanan') as KasPeriod;
  const at = now();
  const parts = allocatePayment({
    nominal: input.nominal,
    memberId: input.member.platformUserId,
    entries: await ledgerEntries(input.groupId),
    kasPeriod,
    rate: rateOf(g),
    start: billingStart(g, at),
    current: periodKey(at, kasPeriod),
  });
  await TransactionModel.insertMany(
    parts.map((p) => ({
      platform: input.platform,
      groupId: input.groupId,
      memberId: input.member.platformUserId,
      memberName: input.member.displayName,
      amount: p.amount,
      kind: 'iuran',
      period: p.period,
      note: input.note,
      proofId: input.proofId ?? null,
      createdBy: input.actorId,
    })),
  );
  await markKasDirty(input.groupId);
  return parts;
}

const allocationText = (parts: { period: string; amount: number }[]) => parts.map((p) => `${periodLabel(p.period)}${p.amount ? ` ${rupiah(p.amount)}` : ''}`).join(', ');

const isTreasurer = (g: GroupDoc, ctx: { isAdmin: boolean; actor: { platformUserId: string } }) => can(g, ctx, 'kas');

/** Gambar di channel kas → ekstraksi vision → verifikasi → tunggu persetujuan bendahara. */
export async function handleKasProof(llm: LLMProvider, msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[]> {
  if (!msg.isDirect && (!group.kasChannelId || msg.channelId !== group.kasChannelId)) return [];
  const image = msg.attachments.find(isImage);
  if (!image) return [];
  if ((image.size ?? 0) > MAX_PROOF_BYTES) {
    return [{ to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id }, text: 'Gambarnya kegedean (maks 10 MB) 🙏 Coba kirim screenshot biasa ya.' }];
  }

  const data = await image.getData();
  const imageHash = createHash('sha256').update(data).digest('hex');
  const imagePHash = perceptualHash(data);
  const at = now();
  const extracted = await visionJson(llm, ProofSchema, kasProofPrompt(formatWIB(at)), {
    data,
    mimeType: image.contentType ?? 'image/jpeg',
  });

  const previous = await KasProofModel.find({ groupId: msg.groupId, status: { $ne: 'rejected' } }, { imageHash: 1, imagePHash: 1, refId: 1, refHash: 1, nominal: 1, transferDate: 1, recipient: 1 }).lean();
  const kasPeriod = (group.kas?.period ?? 'bulanan') as KasPeriod;
  const clean = (v: string | null | undefined) => (v ? sanitize(v).slice(0, 100) : null);
  const proof = {
    nominal: extracted?.nominal ?? null,
    tanggal: clean(extracted?.tanggal),
    refId: clean(extracted?.refId),
    imageHash,
    imagePHash,
    penerima: clean(extracted?.penerima),
    isTransferProof: extracted?.isTransferProof,
  };
  const flags = verifyProof(proof, {
    now: at,
    amount: group.kas?.amount ?? 0,
    period: kasPeriod,
    seenHashes: new Set(previous.map((p) => p.imageHash)),
    seenImages: previous
      .filter((p) => p.imagePHash)
      .map((p) => ({ pHash: p.imagePHash!, refKey: p.refHash ?? (p.refId ? refHashOf(p.refId) : null), nominal: p.nominal ?? null, tanggal: p.transferDate ?? null, penerima: p.recipient ?? null })),
    recipients: group.kas?.recipients ?? [],
    seenRefIds: new Set(previous.map((p) => p.refHash ?? (p.refId ? refHashOf(p.refId) : null)).filter((h): h is string => Boolean(h))),
    refKey: refHashOf,
  });

  const transferAt = proof.tanggal?.match(/^\d{4}-\d{2}-\d{2}$/) ? new Date(`${proof.tanggal}T05:00:00Z`) : at;
  const doc = await KasProofModel.create({
    platform: msg.platform,
    groupId: msg.groupId,
    channelId: msg.channelId,
    member: { platformUserId: msg.author.platformUserId, displayName: msg.author.displayName },
    imageHash,
    imagePHash,
    nominal: proof.nominal,
    transferDate: proof.tanggal,
    bank: clean(extracted?.bank),
    sender: clean(extracted?.pengirim),
    recipient: proof.penerima,
    refId: proof.refId,
    refHash: proof.refId ? refHashOf(proof.refId) : null,
    flags,
    period: periodKey(transferAt > at ? at : transferAt, kasPeriod),
  });
  await markKasDirty(msg.groupId);
  return deliverProof(doc.toObject() as KasProofDoc, group, { replyTo: msg.id, isDirect: Boolean(msg.isDirect), sender: msg.author, readerOn: llm.enabled });
}

type KasProofDoc = InferSchemaType<typeof KasProofModel.schema> & { _id: Types.ObjectId };

function proofCard(p: KasProofDoc, readerOn: boolean): Card {
  const flags = p.flags as ProofFlag[];
  return {
    title: flags.length ? '🧾 Bukti transfer — perlu dicek' : '🧾 Bukti transfer diterima',
    tone: flags.length ? 'warn' : 'info',
    fields: [
      { name: 'Dari', value: mention(p.member), inline: true },
      { name: 'Nominal', value: p.nominal ? rupiah(p.nominal) : '—', inline: true },
      { name: 'Tanggal', value: p.transferDate ?? '—', inline: true },
      { name: 'Bank/e-wallet', value: p.bank ?? '—', inline: true },
      { name: 'Ke', value: p.recipient ?? '—', inline: true },
      { name: 'Ref', value: p.refId ?? '—', inline: true },
      { name: 'Periode', value: periodLabel(p.period), inline: true },
    ],
    description: flags.length
      ? flags.map((f) => `⚠️ ${FLAG_TEXT[f]}`).join('\n')
      : readerOn
        ? 'Tidak ada kejanggalan yang terdeteksi. Menunggu persetujuan bendahara.'
        : 'Pembaca gambar (LLM vision) belum aktif — bendahara mohon cek manual.',
    footer: 'Bot hanya mencatat & memeriksa kejanggalan umum, bukan forensik. Uang tetap lewat bank/e-wallet.',
  };
}

/** Kartu bukti untuk bendahara/tim inti — tujuan sesuai pengaturan kas. Juga dipakai untuk kirim ulang. */
function reviewMessage(p: KasProofDoc, group: GroupDoc, readerOn: boolean, viaDm: boolean): OutgoingMessage {
  const id = String(p._id);
  const author = { platformUserId: p.member.platformUserId };
  // Bendahara disebut sekali saja (kalau pengirim = bendahara, tidak perlu dua kali — temuan QA T15).
  const treasurer = group.kas?.treasurerId && group.kas.treasurerId !== author.platformUserId ? ` ${mention({ platformUserId: group.kas.treasurerId })}` : '';
  const actions = [
    { id: ids.approve(id), label: '✅ Setujui', kind: 'success' as const },
    { id: ids.reject(id), label: '❌ Tolak', kind: 'danger' as const },
  ];
  const text = `Ada bukti kas baru dari ${mention(author)} 🧾${treasurer}`;
  const afterSend = async () => void (await KasProofModel.updateOne({ _id: p._id }, { $set: { reviewSentAt: now() } }));
  const card = proofCard(p, readerOn);
  if (group.kas?.reviewChannelId) return { to: { kind: 'channel', channelId: group.kas.reviewChannelId }, text, card, actions, afterSend };
  const fallbackChannelId = group.kasChannelId ?? group.mainChannelId;
  if (viaDm && group.kas?.treasurerId) {
    return {
      to: { kind: 'dm', member: { platform: p.platform as Platform, groupId: p.groupId, platformUserId: group.kas.treasurerId, displayName: 'Bendahara' }, fallbackChannelId },
      text,
      card,
      actions,
      afterSend,
    };
  }
  return { to: { kind: 'channel', channelId: viaDm ? fallbackChannelId : p.channelId }, text, card, actions, afterSend };
}

function deliverProof(p: KasProofDoc, group: GroupDoc, ctx: { replyTo: string; isDirect: boolean; sender: { platformUserId: string }; readerOn: boolean }): OutgoingMessage[] {
  const review = reviewMessage(p, group, ctx.readerOn, ctx.isDirect);
  const here = { kind: 'channel' as const, channelId: p.channelId, replyTo: ctx.replyTo };
  const sameChannel = review.to.kind === 'channel' && review.to.channelId === p.channelId;
  if (sameChannel) {
    // Kartu langsung di channel kas (tidak ada channel tim inti): kartu itu sendiri sudah jadi tanda terima.
    return [{ ...review, to: here, text: `Terima kasih ${mention(ctx.sender)} 🙏 Bukti dicatat, menunggu cek bendahara.${review.text!.slice(review.text!.indexOf('🧾') + 2)}` }];
  }
  // Kartu dikirim DULU; ucapan "udah aku terusin" hanya kalau kartunya benar-benar sampai.
  return [
    review,
    {
      to: here,
      text: `Makasih ${mention(ctx.sender)} 🙏 Buktinya udah aku terusin ke bendahara buat dicek.`,
      onlyIfPreviousSent: true,
      elseText: `Makasih ${mention(ctx.sender)} 🙏 Buktinya sudah kucatat, tapi belum bisa kuteruskan ke bendahara — nanti aku coba kirim ulang otomatis.`,
    },
  ];
}

/** Scheduler: kartu bukti yang belum sampai ke bendahara (mis. sempat gagal kirim) dikirim ulang, maks 5x. */
export async function collectUndeliveredProofs(at: Date): Promise<OutgoingMessage[]> {
  const rows = await KasProofModel.find({
    status: 'pending',
    reviewSentAt: null,
    // $not juga cocok dengan dokumen lama yang belum punya field ini.
    reviewAttempts: { $not: { $gte: 5 } },
    lastAttemptAt: { $not: { $gt: new Date(at.getTime() - 2 * 60_000) } },
  })
    .limit(20)
    .lean<KasProofDoc[]>();
  const out: OutgoingMessage[] = [];
  for (const p of rows) {
    const g = await getGroup(p.platform as Platform, p.groupId);
    if (!g || g.pilotMode === 'jeda') continue;
    const claimed = await KasProofModel.findOneAndUpdate(
      { _id: p._id, reviewSentAt: null, reviewAttempts: p.reviewAttempts ?? { $exists: false } },
      { $inc: { reviewAttempts: 1 }, $set: { lastAttemptAt: at } },
    );
    if (!claimed) continue;
    const viaDm = p.channelId !== g.kasChannelId && p.channelId !== g.mainChannelId;
    const m = reviewMessage(p, g, true, viaDm);
    out.push({ ...m, text: `${m.text} _(kirim ulang)_` });
  }
  return out;
}

/** Bukti dikirim lewat chat pribadi → kabari pengirimnya di chat itu juga (tombol ada di chat bendahara). */
/**
 * Bukti ditinjau di tempat lain (chat pribadi bendahara / channel tim inti) → kabari pengirimnya.
 * Lewat chat pribadi pengirim kalau bukti dikirim lewat DM; selain itu DM ke pengirim (penolakan tidak
 * pernah diumumkan di grup).
 */
function notifyPrivateSender(
  proof: { channelId: string; member: { platformUserId: string; displayName: string } },
  group: GroupDoc,
  ev: { platform: ActionEvent['platform']; groupId: string; channelId: string },
  text: string,
): OutgoingMessage[] {
  if (ev.channelId === proof.channelId) return []; // pengirim melihat sendiri hasilnya di pesan yang sama
  const viaGroup = proof.channelId === group.kasChannelId || proof.channelId === group.mainChannelId;
  if (!viaGroup) return [{ to: { kind: 'channel', channelId: proof.channelId }, text }];
  const member = { platform: ev.platform, groupId: ev.groupId, platformUserId: proof.member.platformUserId, displayName: proof.member.displayName };
  return [{ to: { kind: 'dm', member, fallbackChannelId: proof.channelId, fallbackText: `${mention(member)}, ada kabar soal bukti kasmu — buka DM dari aku ya 🙏` }, text }];
}

async function approve(proofId: string, nominal: number, ev: ActionEvent | FormSubmit, group: GroupDoc): Promise<Reply> {
  const proof = await KasProofModel.findOneAndUpdate(
    // Bukan bukti milik sendiri (kecuali admin) — berlaku juga lewat form nominal.
    { _id: proofId, groupId: ev.groupId, status: 'pending', ...(ev.isAdmin ? {} : { 'member.platformUserId': { $ne: ev.actor.platformUserId } }) },
    { $set: { status: 'approved', nominal, reviewedBy: ev.actor.platformUserId, reviewedAt: now(), ...SCRUB_AFTER_REVIEW } },
    { returnDocument: 'before' }, // versi sebelum dibersihkan: refId masih ada untuk catatan ledger
  ).lean();
  if (!proof) return { reply: { text: 'Bukti ini sudah diproses (atau milikmu sendiri — perlu dicek tim inti lain).', private: true } };

  // Ke periode tertua yang belum lunas dulu (rapel / sebagian / di muka), dengan tarif per periode.
  const entries = await recordPayment(group, {
    platform: ev.platform,
    groupId: ev.groupId,
    member: proof.member,
    nominal,
    // 4 karakter terakhir cukup untuk mencocokkan dengan mutasi bank tanpa menyimpan nomor lengkap.
    note: proof.refId ? `ref …${normalizeRef(proof.refId).slice(-4)}` : '',
    proofId: proof._id,
    actorId: ev.actor.platformUserId,
  });
  await audit(ev.groupId, ev.actor, 'kas.setujui', `${proof.member.displayName} ${rupiah(nominal)} (${entries.map((e) => periodLabel(e.period)).join(', ')})`, proof.member.platformUserId);

  return {
    update: {
      text: '',
      card: {
        title: '✅ Kas tercatat',
        tone: 'success',
        description: `${mention(proof.member)} — ${rupiah(nominal)} untuk ${entries.map((e) => periodLabel(e.period)).join(', ')}.\nDisetujui ${mention(ev.actor)}. Terima kasih atas gotong royongnya 🙏`,
      },
      actions: [],
    },
    messages: notifyPrivateSender(proof, group, ev, `Kas kamu ${rupiah(nominal)} udah tercatat untuk ${entries.map((e) => periodLabel(e.period)).join(', ')} ✅ Makasih ya!`),
  };
}

export async function handleKasAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, id, extra] = ev.actionId.split(':');
  const group = await getGroup(ev.platform, ev.groupId);
  if (verb === 'cashno') return { update: { text: 'Dibatalkan — tidak ada yang dicatat.', card: undefined, actions: [] } };
  if (verb === 'cash') {
    if (!group || !isTreasurer(group, ev)) return { reply: { text: 'Hanya bendahara / tim inti kas yang bisa mencatat bayar tunai.', private: true } };
    const nominal = Number(extra);
    if (!id || !Number.isInteger(nominal) || nominal <= 0 || nominal > 10_000_000) return { reply: { text: 'Data tidak valid.', private: true } };
    return saveCash(ev, group, id, nominal);
  }
  if (!group || !id || !isValidObjectId(id)) return { reply: { text: 'Data tidak ditemukan.', private: true } };
  if (!isTreasurer(group, ev)) return { reply: { text: 'Hanya bendahara atau pengurus kelas yang bisa memproses bukti kas.', private: true } };
  const proof = await KasProofModel.findOne({ _id: id, groupId: ev.groupId }).lean();
  if (!proof || proof.status !== 'pending') return { reply: { text: 'Bukti ini sudah diproses.', private: true } };
  // Tidak boleh menyetujui/menolak bukti milik sendiri (kecuali admin server).
  if (!ev.isAdmin && proof.member.platformUserId === ev.actor.platformUserId) {
    return { reply: { text: 'Bukti milikmu sendiri harus dicek anggota tim inti lain 🙏', private: true } };
  }

  if (verb === 'no') {
    await KasProofModel.updateOne({ _id: id }, { $set: { status: 'rejected', reviewedBy: ev.actor.platformUserId, reviewedAt: now(), ...SCRUB_AFTER_REVIEW } });
    await markKasDirty(ev.groupId);
    await audit(ev.groupId, ev.actor, 'kas.tolak', `${proof.member.displayName}${proof.flags.length ? ` — ${proof.flags.join(', ')}` : ''}`, proof.member.platformUserId);
    return {
      update: {
        text: '',
        card: {
          title: '❌ Bukti ditolak',
          tone: 'danger',
          description: `${mention(proof.member)}, bukti transfer belum bisa dicatat. Silakan hubungi ${mention(ev.actor)} ya 🙏`,
        },
        actions: [],
      },
      // Beri tahu alasannya (temuan QA T16) — catatan otomatis yang dilihat bendahara.
      messages: notifyPrivateSender(
        proof,
        group,
        ev,
        `Bukti transfer kasmu belum bisa dicatat 🙏${proof.flags.length ? `\nCatatan: ${(proof.flags as ProofFlag[]).map((f) => FLAG_TEXT[f].toLowerCase()).join('; ')}.` : ''}\nKalau ada yang keliru, hubungi ${mention(ev.actor)} ya.`,
      ),
    };
  }
  if (verb === 'ok') {
    if (!proof.nominal) {
      return {
        form: {
          id: ids.form(id),
          title: 'Nominal transfer',
          fields: [{ id: 'nominal', label: 'Nominal (angka, rupiah)', placeholder: String(group.kas?.amount || 10000), required: true }],
        },
      };
    }
    return approve(id, proof.nominal, ev, group);
  }
  return { reply: { text: 'Aksi tidak dikenal.', private: true } };
}

export async function handleKasForm(ev: FormSubmit): Promise<Reply> {
  const id = ev.formId.split(':')[2];
  const group = await getGroup(ev.platform, ev.groupId);
  if (!group || !id || !isValidObjectId(id)) return { reply: { text: 'Data tidak ditemukan.', private: true } };
  if (!isTreasurer(group, ev)) return { reply: { text: 'Hanya bendahara yang bisa menyetujui.', private: true } };
  const nominal = Number((ev.values.nominal ?? '').replace(/[^\d]/g, ''));
  if (!nominal || nominal > 100_000_000) return { reply: { text: 'Nominal tidak valid.', private: true } };
  return approve(id, nominal, ev, group);
}

// ---------- Slash command ----------

export async function kasAtur(cmd: CommandInvocation, ops: PlatformOps = {}): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  // Atur iuran: bendahara (peran) atau admin — bukan sekadar anggota tim pemeriksa bukti.
  const isBendahara = cmd.isAdmin || rolesOf(group, cmd.actor.platformUserId).includes('bendahara');
  if (!isBendahara) return { reply: { text: 'Hanya bendahara atau admin server yang bisa mengatur kas.', private: true } };
  // Mengganti bendahara / tim inti = urusan ketua atau admin (sebaiknya lewat /tim).
  const sensitive = ['bendahara', 'tambah_tim', 'hapus_tim'].some((k) => cmd.options[k] !== undefined);
  if (sensitive && !can(group, cmd, 'kelola')) return { reply: { text: 'Mengganti bendahara / tim inti hanya bisa oleh ketua kelas atau admin — pakai /tim.', private: true } };
  const amount = Number(cmd.options.nominal);
  const period = (cmd.options.periode as KasPeriod) ?? 'bulanan';
  const treasurerId = (cmd.options.bendahara as string | undefined) ?? group.kas?.treasurerId ?? null;
  if (!Number.isFinite(amount) || amount <= 0) return { reply: { text: 'Nominal harus angka > 0.', private: true } };
  // Riwayat tarif: perubahan berlaku mulai periode berikutnya (atau periode ini kalau diminta / baru pertama kali).
  const changed = amount !== group.kas?.amount || period !== group.kas?.period;
  const currentKey = periodKey(now(), period);
  const startNow = !group.kas?.amount || cmd.options.mulai === 'ini' || period !== group.kas?.period;
  const from = startNow ? currentKey : nextPeriod(currentKey, period);
  const rates: Rate[] = [...((group.kas?.rates as Rate[] | undefined) ?? [])];
  if (changed) {
    if (!rates.length && group.kas?.amount) rates.push({ amount: group.kas.amount, period: (group.kas.period ?? 'bulanan') as KasPeriod, from: '0000' });
    const kept = rates.filter((r) => !(r.period === period && r.from >= from));
    kept.push({ amount, period, from });
    rates.splice(0, rates.length, ...kept);
  }
  const recipients =
    typeof cmd.options.penerima === 'string'
      ? cmd.options.penerima.split(',').map((r) => r.trim().slice(0, 80)).filter(Boolean).slice(0, 5)
      : (group.kas?.recipients ?? []);
  // Set per field: jangan menghapus pengaturan kas lain yang tidak disebut.
  await GroupModel.updateOne(
    { _id: group._id },
    {
      $set: {
        'kas.amount': amount,
        'kas.period': period,
        'kas.treasurerId': treasurerId,
        'kas.recipients': recipients,
        'kas.rates': rates,
        // Nominal/periode berubah = mulai lagi masa tenggang sebelum pengingat otomatis.
        ...(amount !== group.kas?.amount || period !== group.kas?.period ? { 'kas.setAt': now() } : {}),
      },
    },
  );

  await markKasDirty(cmd.groupId);
  await audit(cmd.groupId, cmd.actor, 'kas.atur', `${rupiah(amount)}/${period}${changed ? ` mulai ${periodLabel(from)}` : ''}${typeof cmd.options.bendahara === 'string' ? `, bendahara ${await memberName(cmd.platform, cmd.groupId, cmd.options.bendahara)}` : ''}`, typeof cmd.options.bendahara === 'string' ? cmd.options.bendahara : null);
  // Tempat cek bukti: channel tim inti (disebut / dicari / dibuatkan) atau DM bendahara.
  let reviewNote: string | null = null;
  const wantChannel = cmd.options.cek_bukti === 'channel' || typeof cmd.options.channel_tim === 'string';
  if (wantChannel) {
    const ch = await ensureReviewChannel(ops, {
      groupId: cmd.groupId,
      nearChannelId: cmd.channelId,
      allowUserIds: [treasurerId ?? '', cmd.actor.platformUserId],
      channelId: (cmd.options.channel_tim as string | undefined) ?? null,
    });
    if (ch) {
      await saveReviewTarget(cmd.platform, cmd.groupId, { mode: 'channel', channel: ch });
      reviewNote = ch.created
        ? `${channelRef(ch.channelId)} (baru dibuat, privat untuk tim inti 🔒)`
        : `${channelRef(ch.channelId)}${ch.private ? ' 🔒' : ' — ⚠️ channel ini bisa dilihat semua anggota; detail bukti ikut terlihat. Sebaiknya pakai channel privat'}`;
    } else {
      reviewNote = 'channel tim inti tidak bisa dibuat (izin Manage Channels?) — sementara lewat DM bendahara';
      await saveReviewTarget(cmd.platform, cmd.groupId, { mode: 'dm' });
    }
  } else if (cmd.options.cek_bukti === 'dm') {
    await saveReviewTarget(cmd.platform, cmd.groupId, { mode: 'dm' });
    reviewNote = 'DM bendahara';
  }
  if (typeof cmd.options.hapus_tim === 'string') {
    await removeReviewer(cmd.platform, cmd.groupId, cmd.options.hapus_tim);
    reviewNote = `${reviewNote ? `${reviewNote}\n` : ''}${mention({ platformUserId: cmd.options.hapus_tim })} dikeluarkan dari tim inti (tidak bisa menyetujui bukti lagi; akses channel tim inti cabut manual kalau perlu)`;
  }
  if (typeof cmd.options.tambah_tim === 'string') {
    const fresh = await getGroup(cmd.platform, cmd.groupId);
    const granted = await addReviewer(ops, cmd.platform, cmd.groupId, cmd.options.tambah_tim, fresh?.kas?.reviewChannelId ?? null);
    const who = mention({ platformUserId: cmd.options.tambah_tim });
    reviewNote = `${reviewNote ? `${reviewNote}\n` : ''}${who} masuk tim inti (boleh menyetujui bukti)${fresh?.kas?.reviewChannelId ? (granted ? ' dan sudah bisa melihat channel tim inti' : ' — beri dia akses channel tim inti secara manual') : ''}`;
  }
  return {
    reply: {
      card: {
        title: '💰 Kas kelas diatur',
        tone: 'success',
        fields: [
          { name: 'Iuran', value: `${rupiah(amount)} / ${period === 'bulanan' ? 'bulan' : 'minggu'}${changed ? ` (mulai ${periodLabel(from)})` : ''}`, inline: true },
          { name: 'Bendahara', value: treasurerId ? mention({ platformUserId: treasurerId }) : '—', inline: true },
          { name: 'Channel bukti', value: group.kasChannelId ? channelRef(group.kasChannelId) : 'belum diatur di /setup', inline: true },
          ...(reviewNote ? [{ name: 'Bukti dicek di', value: reviewNote, inline: false }] : []),
          { name: 'Rekening tujuan', value: recipients.length ? recipients.join(', ') : 'belum diatur — tambahkan opsi `penerima` agar bukti ke rekening lain ditandai', inline: false },
        ],
        footer: 'Kirim foto bukti transfer di channel kas. Bot hanya mencatat — uang tidak dipegang bot.',
      },
    },
  };
}

export async function ledgerEntries(groupId: string): Promise<LedgerEntry[]> {
  const rows = await TransactionModel.find({ groupId }).sort({ createdAt: 1 }).lean();
  return rows.map((r) => ({
    id: String(r._id),
    memberId: r.memberId ?? null,
    memberName: r.memberName,
    amount: r.amount,
    kind: r.kind as LedgerEntry['kind'],
    period: r.period,
    createdAt: r.createdAt as Date,
    note: r.note ?? undefined,
    reversalOf: r.reversalOf ? String(r.reversalOf) : undefined,
  }));
}

export async function kasRekap(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!group.kas?.amount) return { reply: { text: 'Kas belum diatur. Jalankan `/kas atur` dulu.', private: true } };
  const kasPeriod = group.kas.period as KasPeriod;
  const period = periodKey(now(), kasPeriod);
  const [members, entries] = await Promise.all([listMembers(cmd.platform, cmd.groupId), ledgerEntries(cmd.groupId)]);
  const status = paidStatus(
    members.map((m) => ({ id: m.platformUserId, name: m.displayName })),
    entries,
    rateOf(group),
    period,
  );
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const pending = await KasProofModel.countDocuments({ groupId: cmd.groupId, status: 'pending' });
  const list = (xs: { name: string; paidAmount: number }[], showPartial: boolean) =>
    xs.length ? xs.map((x) => `• ${x.name}${showPartial && x.paidAmount ? ` (${rupiah(x.paidAmount)})` : ''}`).join('\n').slice(0, 1000) : '—';
  const publik = cmd.options.umumkan === true && isTreasurer(group, cmd);
  return {
    reply: {
      private: !publik,
      card: {
        title: `💰 Rekap kas ${group.className} — ${periodLabel(period)}`,
        tone: 'info',
        description: `Iuran ${rupiah(group.kas.amount)} · Saldo tercatat **${rupiah(total)}**${pending ? ` · ${pending} bukti menunggu cek` : ''}`,
        fields: [
          { name: `Sudah (${status.paid.length})`, value: list(status.paid, false), inline: true },
          { name: `Belum (${status.unpaid.length})`, value: list(status.unpaid, true), inline: true },
        ],
        footer: publik ? 'Terima kasih yang sudah gotong royong 🙏' : 'Hanya kamu yang melihat rekap ini.',
      },
    },
  };
}

/** Tandai Google Sheet kelas perlu ditulis ulang (job sinkron yang menulis). Tanpa sheet → tidak apa-apa. */
export async function markKasDirty(groupId: string): Promise<void> {
  await GroupModel.updateOne({ groupId, 'kas.sheetId': { $ne: null } }, { $set: { 'kas.sheetDirtyAt': new Date() } }).catch(() => undefined);
}

const SHEET_HELP = (email: string) =>
  `Cara menyambungkan laporan kas ke Google Sheets:\n` +
  `1. Buat Google Sheet kosong (sheets.new).\n` +
  `2. Klik **Share/Bagikan** → tambahkan \`${email}\` sebagai **Editor**.\n` +
  `3. Tempel linknya: \`/kas sheet link:https://docs.google.com/spreadsheets/d/...\`\n` +
  `Aku isi tab Ringkasan, Buku Kas, Status Iuran, dan Bukti Transfer, lalu memperbaruinya otomatis tiap ada perubahan.\n` +
  `⚠️ Sheet berisi nama & status bayar anggota — bagikan hanya ke pengurus.`;

/** /kas sheet [link] — sambungkan / lihat status Google Sheet laporan kas. */
export async function kasSheet(cmd: CommandInvocation, sheets?: KasSheetGateway): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!isTreasurer(group, cmd)) return { reply: { text: 'Laporan kas di Google Sheets hanya bisa diatur bendahara / pengurus.', private: true } };
  if (!sheets) return { reply: { text: 'Integrasi Google Sheets belum diaktifkan di bot ini (operator bot perlu mengisi GOOGLE_SERVICE_ACCOUNT_FILE). Sementara pakai `/kas ekspor` (CSV).', private: true } };
  const link = typeof cmd.options.link === 'string' ? cmd.options.link.trim() : '';
  if (!link) {
    const k = group.kas;
    const status = k?.sheetId
      ? `📊 Tersambung ke **${k.sheetTitle ?? 'Google Sheet'}**: https://docs.google.com/spreadsheets/d/${k.sheetId}\n` +
        (k.sheetError ? `⚠️ Sinkron terakhir gagal: ${k.sheetError}` : k.sheetSyncedAt ? `Terakhir diperbarui ${formatWIB(k.sheetSyncedAt)}.` : 'Sedang disiapkan…')
      : 'Belum ada Google Sheet yang tersambung.';
    return { reply: { text: `${status}\n\n${SHEET_HELP(sheets.serviceEmail)}`, private: true } };
  }
  if (link === 'putus' || link === 'hapus') {
    await GroupModel.updateOne({ _id: group._id }, { $set: { 'kas.sheetId': null, 'kas.sheetTitle': null, 'kas.sheetError': null } });
    return { reply: { text: 'Google Sheet diputus — aku berhenti memperbaruinya (isinya tidak dihapus).', private: true } };
  }
  const id = spreadsheetIdOf(link);
  if (!id) return { reply: { text: 'Itu bukan link Google Sheets. Contoh: https://docs.google.com/spreadsheets/d/…/edit', private: true } };
  const check = await sheets.check(id);
  if (!check.ok) return { reply: { text: `Belum bisa dibuka: ${check.reason}.\n\n${SHEET_HELP(sheets.serviceEmail)}`, private: true } };
  // Jangan sampai laporan kelas lain tertimpa: sheet hanya untuk satu kelas.
  const mine = sheetMarker(cmd.platform, cmd.groupId);
  const taken = await GroupModel.exists({ 'kas.sheetId': id, _id: { $ne: group._id } });
  if (taken || (check.marker && check.marker !== mine)) {
    return { reply: { text: 'Sheet ini sudah dipakai untuk laporan kas kelas lain. Buat Google Sheet baru khusus kelas ini ya.', private: true } };
  }
  await GroupModel.updateOne(
    { _id: group._id },
    { $set: { 'kas.sheetId': id, 'kas.sheetTitle': check.title.slice(0, 100), 'kas.sheetDirtyAt': new Date(), 'kas.sheetSyncedAt': null, 'kas.sheetError': null } },
  );
  await audit(cmd.groupId, cmd.actor, 'kas.sheet', check.title.slice(0, 100));
  return {
    reply: {
      text: `✅ Tersambung ke **${sanitize(check.title.slice(0, 100))}**. Dalam ±1 menit aku isi tab Ringkasan, Buku Kas, Status Iuran, dan Bukti Transfer — setelah itu diperbarui otomatis.\nhttps://docs.google.com/spreadsheets/d/${id}`,
      private: true,
    },
  };
}

/** /kas tunai anggota nominal — pratinjau alokasi dulu, simpan lewat tombol (bendahara). */
export async function kasTunai(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!isTreasurer(group, cmd)) return { reply: { text: 'Hanya bendahara / tim inti kas yang bisa mencatat bayar tunai.', private: true } };
  if (!group.kas?.amount) return { reply: { text: 'Atur iuran dulu: /kas atur', private: true } };
  const who = cmd.options.anggota as string | undefined;
  const nominal = Number(cmd.options.nominal);
  if (!who || !Number.isInteger(nominal) || nominal <= 0 || nominal > 10_000_000) return { reply: { text: 'Sebut anggotanya & nominal rupiah.', private: true } };
  if (who === cmd.actor.platformUserId && !cmd.isAdmin) return { reply: { text: 'Bayar tunai milikmu sendiri dicatat oleh anggota tim inti lain ya 🙏', private: true } };
  const at = now();
  const kasPeriod = group.kas.period as KasPeriod;
  const parts = allocatePayment({
    nominal,
    memberId: who,
    entries: await ledgerEntries(cmd.groupId),
    kasPeriod,
    rate: rateOf(group),
    start: billingStart(group, at),
    current: periodKey(at, kasPeriod),
  });
  return {
    reply: {
      private: true,
      card: {
        title: `💵 Bayar tunai ${rupiah(nominal)}`,
        tone: 'info',
        description: `Dari ${mention({ platformUserId: who })} → dialokasikan ke **${allocationText(parts)}** (bulan tertua yang belum lunas dulu).`,
        footer: 'Cek dulu, lalu simpan. Setelah disimpan tidak bisa diubah — koreksi = transaksi baru.',
      },
      actions: [
        { id: `k:cash:${who}:${nominal}`, label: '✅ Simpan', kind: 'success' },
        { id: 'k:cashno:x', label: 'Batal', kind: 'secondary' },
      ],
    },
  };
}

async function saveCash(ev: ActionEvent, group: GroupDoc, who: string, nominal: number): Promise<Reply> {
  if (who === ev.actor.platformUserId && !ev.isAdmin) return { reply: { text: 'Bayar tunai milikmu sendiri dicatat anggota tim inti lain ya 🙏', private: true } };
  const member = (await listMembers(ev.platform, ev.groupId)).find((m) => m.platformUserId === who) ?? { platformUserId: who, displayName: await memberName(ev.platform, ev.groupId, who) };
  const parts = await recordPayment(group, {
    platform: ev.platform,
    groupId: ev.groupId,
    member,
    nominal,
    note: 'tunai', // penerima tercatat di createdBy & jejak audit — tanpa nama di buku kas
    actorId: ev.actor.platformUserId,
  });
  await audit(ev.groupId, ev.actor, 'kas.tunai', `${member.displayName} ${rupiah(nominal)} (${allocationText(parts)})`, who);
  return {
    update: { text: `✅ Tunai ${rupiah(nominal)} dari ${mention({ platformUserId: who })} tercatat: ${allocationText(parts)}.`, card: undefined, actions: [] },
    messages: [
      {
        to: { kind: 'dm', member: { ...member, platform: ev.platform, groupId: ev.groupId }, fallbackChannelId: group.kasChannelId ?? group.mainChannelId, fallbackText: `${mention({ platformUserId: who })}, ada kabar soal kasmu — buka DM dari aku ya 🙏` },
        text: `Bayar tunai ${rupiah(nominal)} ke ${ev.actor.displayName} sudah kucatat untuk ${allocationText(parts)} ✅ Makasih!`,
      },
    ],
  };
}

/** /kas keluar & /kas masuk — pengeluaran kas dan pemasukan selain iuran (bendahara). */
export async function kasArus(cmd: CommandInvocation, kind: 'pengeluaran' | 'pemasukan'): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!isTreasurer(group, cmd)) return { reply: { text: 'Hanya bendahara / tim inti yang bisa mencatat arus kas.', private: true } };
  const nominal = Number(cmd.options.nominal);
  const why = String(cmd.options.keperluan ?? cmd.options.keterangan ?? '').trim().slice(0, 120);
  if (!Number.isInteger(nominal) || nominal <= 0 || nominal > 100_000_000) return { reply: { text: 'Nominal harus angka rupiah > 0.', private: true } };
  if (!why) return { reply: { text: 'Tulis keperluannya ya (mis. "beli spidol").', private: true } };
  const at = now();
  const entries = await ledgerEntries(cmd.groupId);
  const saldo = entries.reduce((s, e) => s + e.amount, 0);
  if (kind === 'pengeluaran' && nominal > saldo) return { reply: { text: `Saldo kas cuma ${rupiah(saldo)} — pengeluaran ${rupiah(nominal)} belum bisa dicatat. Cek lagi ya.`, private: true } };
  await TransactionModel.create({
    platform: cmd.platform,
    groupId: cmd.groupId,
    memberId: null,
    memberName: why,
    amount: kind === 'pengeluaran' ? -nominal : nominal,
    kind,
    period: periodKey(at, (group.kas?.period ?? 'bulanan') as KasPeriod),
    note: '', // pencatat tercatat di createdBy & jejak audit
    createdBy: cmd.actor.platformUserId,
  });
  await markKasDirty(cmd.groupId);
  await audit(cmd.groupId, cmd.actor, kind === 'pengeluaran' ? 'kas.keluar' : 'kas.masuk', `${rupiah(nominal)} — ${why}`);
  const after = saldo + (kind === 'pengeluaran' ? -nominal : nominal);
  return {
    reply: {
      card: {
        title: kind === 'pengeluaran' ? '💸 Pengeluaran kas dicatat' : '💰 Pemasukan kas dicatat',
        tone: 'success',
        fields: [
          { name: kind === 'pengeluaran' ? 'Keperluan' : 'Keterangan', value: sanitize(why), inline: true },
          { name: 'Nominal', value: rupiah(nominal), inline: true },
          { name: 'Saldo sekarang', value: rupiah(after), inline: true },
        ],
        footer: `Dicatat oleh ${cmd.actor.displayName}. Koreksi = catat transaksi baru (buku kas tidak bisa diubah).`,
      },
    },
  };
}

export async function kasEkspor(cmd: CommandInvocation): Promise<Reply> {
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (!isTreasurer(group, cmd)) return { reply: { text: 'Ekspor ledger hanya untuk bendahara / pengurus.', private: true } };
  const entries = await ledgerEntries(cmd.groupId);
  return {
    reply: {
      private: true,
      text: `Ledger kas ${group.className}: ${entries.length} transaksi (bahan LPJ).`,
      file: { name: `kas-${group.className.replace(/\s+/g, '_')}-${formatWIB(now(), 'iso').slice(0, 10)}.csv`, content: toCsv(entries) },
    },
  };
}

// ---------- Pengingat kas (scheduler) ----------

function kasStageDue(period: string, at: Date): KasStage | null {
  const { start, end } = periodRange(period);
  const len = end.getTime() - start.getTime();
  const endStageAt = end.getTime() - Math.min(2 * 86400_000, len / 4);
  if (at.getTime() >= endStageAt) return 'end';
  if (at.getTime() >= start.getTime() + len / 2) return 'mid';
  return null;
}

export async function collectKasReminders(at: Date): Promise<OutgoingMessage[]> {
  const groups = await GroupModel.find({ 'kas.amount': { $gt: 0 }, pilotMode: { $nin: ['diam', 'jeda'] } }).lean<GroupDoc[]>();
  const out: OutgoingMessage[] = [];
  for (const g of groups) {
    const kasPeriod = g.kas!.period as KasPeriod;
    const period = periodKey(at, kasPeriod);
    const stage = kasStageDue(period, at);
    if (!stage || inQuietHours(at, g.quietHours)) continue;
    // Baru diatur → beri waktu dulu (setengah periode, maks 7 hari), jangan langsung menagih (temuan QA).
    const { start, end } = periodRange(period);
    const grace = Math.min(7 * 86400_000, (end.getTime() - start.getTime()) / 2);
    const since = g.kas?.setAt ?? (g as { createdAt?: Date }).createdAt;
    if (since && at.getTime() - new Date(since).getTime() < grace) continue;
    const [members, entries] = await Promise.all([listMembers(g.platform as Platform, g.groupId), ledgerEntries(g.groupId)]);
    const rate = rateOf(g);
    const { unpaid } = paidStatus(members.map((m) => ({ id: m.platformUserId, name: m.displayName })), entries, rate, period);
    // Anggota yang baru bergabung juga diberi masa tenggang yang sama.
    const joined = new Map(
      (await MemberModel.find({ platform: g.platform, groupId: g.groupId }, { platformUserId: 1, createdAt: 1 }).lean()).map((m) => [m.platformUserId, (m as { createdAt?: Date }).createdAt]),
    );
    for (const u of unpaid) {
      const joinedAt = joined.get(u.id);
      if (joinedAt && at.getTime() - new Date(joinedAt).getTime() < grace) continue;
      try {
        await KasReminderModel.create({ groupId: g.groupId, period, memberId: u.id, stage });
      } catch {
        continue; // sudah diingatkan di tahap ini
      }
      const member = members.find((m) => m.platformUserId === u.id)!;
      const text = kasText(
        g.speechLevel as SpeechLevel,
        stage,
        { nama: mention(member), periode: periodLabel(period), nominal: rupiah(rate(period) - u.paidAmount) },
        `${g.groupId}:${period}:${u.id}:${stage}`,
      );
      // DM tertutup → jangan umumkan siapa yang belum bayar & berapa di channel.
      out.push({ to: { kind: 'dm', member, fallbackChannelId: g.kasChannelId ?? g.mainChannelId, fallbackText: PRIVATE_FALLBACK[g.speechLevel as SpeechLevel](mention(member)) }, text });
    }
  }
  return out;
}
