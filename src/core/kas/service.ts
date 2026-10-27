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
import { addReviewer, ensureReviewChannel, removeReviewer, saveReviewTarget } from './review.ts';
import { paidStatus, periodKey, periodLabel, periodRange, rupiah, toCsv, type KasPeriod, type LedgerEntry } from './ledger.ts';
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

/** Admin, bendahara, atau anggota tim inti yang terdaftar eksplisit — bukan "siapa pun yang bisa lihat channel". */
const isTreasurer = (g: GroupDoc, ctx: { isAdmin: boolean; actor: { platformUserId: string } }) =>
  ctx.isAdmin ||
  (g.kas?.treasurerId != null && g.kas.treasurerId === ctx.actor.platformUserId) ||
  Boolean(g.kas?.reviewerIds?.includes(ctx.actor.platformUserId));

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

  // Bayar beberapa periode sekaligus → pecah per periode agar rekap tepat.
  const amount = group.kas?.amount ?? 0;
  const kasPeriod = (group.kas?.period ?? 'bulanan') as KasPeriod;
  const count = amount > 0 && nominal % amount === 0 ? Math.min(nominal / amount, 12) : 1;
  const per = count > 1 ? amount : nominal;
  let period = proof.period;
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      platform: ev.platform,
      groupId: ev.groupId,
      memberId: proof.member.platformUserId,
      memberName: proof.member.displayName,
      amount: i === count - 1 ? nominal - per * (count - 1) : per,
      kind: 'iuran',
      period,
      // 4 karakter terakhir cukup untuk mencocokkan dengan mutasi bank tanpa menyimpan nomor lengkap.
      note: proof.refId ? `ref …${normalizeRef(proof.refId).slice(-4)}` : '',
      proofId: proof._id,
      createdBy: ev.actor.platformUserId,
    });
    period = periodKey(periodRange(period).end, kasPeriod);
  }
  await TransactionModel.insertMany(entries);

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
  const [, verb, id] = ev.actionId.split(':');
  const group = await getGroup(ev.platform, ev.groupId);
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
  if (!cmd.isAdmin) return { reply: { text: 'Hanya pengurus kelas (admin server) yang bisa mengatur kas.', private: true } };
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const amount = Number(cmd.options.nominal);
  const period = (cmd.options.periode as KasPeriod) ?? 'bulanan';
  const treasurerId = (cmd.options.bendahara as string | undefined) ?? group.kas?.treasurerId ?? null;
  if (!Number.isFinite(amount) || amount <= 0) return { reply: { text: 'Nominal harus angka > 0.', private: true } };
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
        // Nominal/periode berubah = mulai lagi masa tenggang sebelum pengingat otomatis.
        ...(amount !== group.kas?.amount || period !== group.kas?.period ? { 'kas.setAt': now() } : {}),
      },
    },
  );

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
          { name: 'Iuran', value: `${rupiah(amount)} / ${period === 'bulanan' ? 'bulan' : 'minggu'}`, inline: true },
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
    group.kas.amount,
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
    if (!stage) continue;
    // Baru diatur → beri waktu dulu (setengah periode, maks 7 hari), jangan langsung menagih (temuan QA).
    const { start, end } = periodRange(period);
    const grace = Math.min(7 * 86400_000, (end.getTime() - start.getTime()) / 2);
    const since = g.kas?.setAt ?? (g as { createdAt?: Date }).createdAt;
    if (since && at.getTime() - new Date(since).getTime() < grace) continue;
    const [members, entries] = await Promise.all([listMembers(g.platform as Platform, g.groupId), ledgerEntries(g.groupId)]);
    const { unpaid } = paidStatus(members.map((m) => ({ id: m.platformUserId, name: m.displayName })), entries, g.kas!.amount!, period);
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
        { nama: mention(member), periode: periodLabel(period), nominal: rupiah(g.kas!.amount! - u.paidAmount) },
        `${g.groupId}:${period}:${u.id}:${stage}`,
      );
      // DM tertutup → jangan umumkan siapa yang belum bayar & berapa di channel.
      out.push({ to: { kind: 'dm', member, fallbackChannelId: g.kasChannelId ?? g.mainChannelId, fallbackText: PRIVATE_FALLBACK[g.speechLevel as SpeechLevel](mention(member)) }, text });
    }
  }
  return out;
}
