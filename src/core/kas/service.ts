import { createHash } from 'node:crypto';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { GroupModel, KasProofModel, KasReminderModel, TransactionModel, type GroupDoc } from '../../db/models.ts';
import { kasProofPrompt } from '../../llm/prompts/kasProof.ts';
import { visionJson, type LLMProvider } from '../../llm/provider.ts';
import { kasText, type KasStage } from '../billing/templates.ts';
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
  type Reply,
  type SpeechLevel,
} from '../types.ts';
import { paidStatus, periodKey, periodLabel, periodRange, rupiah, toCsv, type KasPeriod, type LedgerEntry } from './ledger.ts';
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

const isTreasurer = (g: GroupDoc, ctx: { isAdmin: boolean; actor: { platformUserId: string } }) =>
  ctx.isAdmin || (g.kas?.treasurerId != null && g.kas.treasurerId === ctx.actor.platformUserId);

/** Gambar di channel kas → ekstraksi vision → verifikasi → tunggu persetujuan bendahara. */
export async function handleKasProof(llm: LLMProvider, msg: IncomingMessage, group: GroupDoc): Promise<OutgoingMessage[]> {
  if (!group.kasChannelId || msg.channelId !== group.kasChannelId) return [];
  const image = msg.attachments.find(isImage);
  if (!image) return [];

  const data = await image.getData();
  const imageHash = createHash('sha256').update(data).digest('hex');
  const at = now();
  const extracted = await visionJson(llm, ProofSchema, kasProofPrompt(formatWIB(at)), {
    data,
    mimeType: image.contentType ?? 'image/jpeg',
  });

  const previous = await KasProofModel.find({ groupId: msg.groupId, status: { $ne: 'rejected' } }, { imageHash: 1, refId: 1 }).lean();
  const kasPeriod = (group.kas?.period ?? 'bulanan') as KasPeriod;
  const clean = (v: string | null | undefined) => (v ? sanitize(v).slice(0, 100) : null);
  const proof = {
    nominal: extracted?.nominal ?? null,
    tanggal: clean(extracted?.tanggal),
    refId: clean(extracted?.refId),
    imageHash,
    isTransferProof: extracted?.isTransferProof,
  };
  const flags = verifyProof(proof, {
    now: at,
    amount: group.kas?.amount ?? 0,
    period: kasPeriod,
    seenHashes: new Set(previous.map((p) => p.imageHash)),
    seenRefIds: new Set(previous.filter((p) => p.refId).map((p) => normalizeRef(p.refId!))),
  });

  const transferAt = proof.tanggal?.match(/^\d{4}-\d{2}-\d{2}$/) ? new Date(`${proof.tanggal}T05:00:00Z`) : at;
  const doc = await KasProofModel.create({
    platform: msg.platform,
    groupId: msg.groupId,
    channelId: msg.channelId,
    member: { platformUserId: msg.author.platformUserId, displayName: msg.author.displayName },
    imageHash,
    nominal: proof.nominal,
    transferDate: proof.tanggal,
    bank: clean(extracted?.bank),
    sender: clean(extracted?.pengirim),
    refId: proof.refId,
    flags,
    period: periodKey(transferAt > at ? at : transferAt, kasPeriod),
  });
  const id = String(doc._id);

  const card: Card = {
    title: flags.length ? '🧾 Bukti transfer — perlu dicek' : '🧾 Bukti transfer diterima',
    tone: flags.length ? 'warn' : 'info',
    fields: [
      { name: 'Dari', value: mention(msg.author), inline: true },
      { name: 'Nominal', value: proof.nominal ? rupiah(proof.nominal) : '—', inline: true },
      { name: 'Tanggal', value: proof.tanggal ?? '—', inline: true },
      { name: 'Bank/e-wallet', value: clean(extracted?.bank) ?? '—', inline: true },
      { name: 'Ref', value: proof.refId ?? '—', inline: true },
      { name: 'Periode', value: periodLabel(doc.period), inline: true },
    ],
    description: flags.length
      ? flags.map((f) => `⚠️ ${FLAG_TEXT[f as ProofFlag]}`).join('\n')
      : llm.enabled
        ? 'Tidak ada kejanggalan yang terdeteksi. Menunggu persetujuan bendahara.'
        : 'Pembaca gambar (LLM vision) belum aktif — bendahara mohon cek manual.',
    footer: 'Bot hanya mencatat & memeriksa kejanggalan umum, bukan forensik. Uang tetap lewat bank/e-wallet.',
  };
  const treasurer = group.kas?.treasurerId ? ` ${mention({ platformUserId: group.kas.treasurerId })}` : '';
  return [
    {
      to: { kind: 'channel', channelId: msg.channelId, replyTo: msg.id },
      text: `Terima kasih ${mention(msg.author)} 🙏 Bukti dicatat, menunggu cek bendahara.${treasurer}`,
      card,
      actions: [
        { id: ids.approve(id), label: '✅ Setujui', kind: 'success' },
        { id: ids.reject(id), label: '❌ Tolak', kind: 'danger' },
      ],
    },
  ];
}

async function approve(proofId: string, nominal: number, ev: ActionEvent | FormSubmit, group: GroupDoc): Promise<Reply> {
  const proof = await KasProofModel.findOneAndUpdate(
    { _id: proofId, groupId: ev.groupId, status: 'pending' },
    { $set: { status: 'approved', nominal, reviewedBy: ev.actor.platformUserId, reviewedAt: now() } },
    { returnDocument: 'after' },
  ).lean();
  if (!proof) return { reply: { text: 'Bukti ini sudah diproses.', private: true } };

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
      note: proof.refId ? `ref ${proof.refId}` : '',
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
  };
}

export async function handleKasAction(ev: ActionEvent): Promise<Reply> {
  const [, verb, id] = ev.actionId.split(':');
  const group = await getGroup(ev.platform, ev.groupId);
  if (!group || !id || !isValidObjectId(id)) return { reply: { text: 'Data tidak ditemukan.', private: true } };
  if (!isTreasurer(group, ev)) return { reply: { text: 'Hanya bendahara atau pengurus kelas yang bisa memproses bukti kas.', private: true } };
  const proof = await KasProofModel.findOne({ _id: id, groupId: ev.groupId }).lean();
  if (!proof || proof.status !== 'pending') return { reply: { text: 'Bukti ini sudah diproses.', private: true } };

  if (verb === 'no') {
    await KasProofModel.updateOne({ _id: id }, { $set: { status: 'rejected', reviewedBy: ev.actor.platformUserId, reviewedAt: now() } });
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

export async function kasAtur(cmd: CommandInvocation): Promise<Reply> {
  if (!cmd.isAdmin) return { reply: { text: 'Hanya pengurus kelas (admin server) yang bisa mengatur kas.', private: true } };
  const group = await getGroup(cmd.platform, cmd.groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  const amount = Number(cmd.options.nominal);
  const period = (cmd.options.periode as KasPeriod) ?? 'bulanan';
  const treasurerId = (cmd.options.bendahara as string | undefined) ?? group.kas?.treasurerId ?? null;
  if (!Number.isFinite(amount) || amount <= 0) return { reply: { text: 'Nominal harus angka > 0.', private: true } };
  await GroupModel.updateOne({ _id: group._id }, { $set: { kas: { amount, period, treasurerId } } });
  return {
    reply: {
      card: {
        title: '💰 Kas kelas diatur',
        tone: 'success',
        fields: [
          { name: 'Iuran', value: `${rupiah(amount)} / ${period === 'bulanan' ? 'bulan' : 'minggu'}`, inline: true },
          { name: 'Bendahara', value: treasurerId ? mention({ platformUserId: treasurerId }) : '—', inline: true },
          { name: 'Channel bukti', value: group.kasChannelId ? channelRef(group.kasChannelId) : 'belum diatur di /setup', inline: true },
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
  const groups = await GroupModel.find({ 'kas.amount': { $gt: 0 } }).lean<GroupDoc[]>();
  const out: OutgoingMessage[] = [];
  for (const g of groups) {
    const kasPeriod = g.kas!.period as KasPeriod;
    const period = periodKey(at, kasPeriod);
    const stage = kasStageDue(period, at);
    if (!stage) continue;
    const [members, entries] = await Promise.all([listMembers(g.platform as Platform, g.groupId), ledgerEntries(g.groupId)]);
    const { unpaid } = paidStatus(members.map((m) => ({ id: m.platformUserId, name: m.displayName })), entries, g.kas!.amount!, period);
    for (const u of unpaid) {
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
      out.push({ to: { kind: 'dm', member, fallbackChannelId: g.kasChannelId ?? g.mainChannelId }, text });
    }
  }
  return out;
}
