import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const MemberRef = new Schema(
  { platformUserId: { type: String, required: true }, displayName: { type: String, required: true } },
  { _id: false },
);

// ---------- Group ----------
const GroupSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    className: { type: String, required: true },
    major: { type: String, required: true },
    speechLevel: { type: String, enum: ['santai', 'sopan', 'krama'], default: 'sopan' },
    mainChannelId: { type: String, required: true },
    kasChannelId: { type: String, default: null },
    oppsChannelId: { type: String, default: null },
    // Pilot: 'diam' = bot hanya mencatat janji tanpa membalas/menagih (minggu baseline).
    // 'jeda' = rem darurat: bot berhenti total di kelas ini (tidak mencatat, membalas, atau menagih).
    pilotMode: { type: String, enum: ['off', 'diam', 'jeda'], default: 'off' },
    lastDigestAt: { type: Date, default: null },
    kas: {
      amount: { type: Number, default: 0 },
      period: { type: String, enum: ['mingguan', 'bulanan'], default: 'bulanan' },
      treasurerId: { type: String, default: null },
      // Kapan iuran diatur — jangan langsung menagih kas yang baru saja diatur.
      setAt: { type: Date, default: null },
      // Nama rekening/e-wallet tujuan kas yang sah; bukti dengan penerima lain ditandai.
      recipients: { type: [String], default: [] },
      // Bukti dicek di channel tim inti (null = DM bendahara / channel kas).
      reviewChannelId: { type: String, default: null },
      // Info saja (untuk peringatan); hak menyetujui TIDAK ditentukan dari visibilitas channel.
      reviewChannelPrivate: { type: Boolean, default: false },
      // Tim inti yang boleh menyetujui bukti selain bendahara & admin (daftar eksplisit).
      reviewerIds: { type: [String], default: [] },
    },
  },
  { timestamps: true },
);
GroupSchema.index({ platform: 1, groupId: 1 }, { unique: true });
export const GroupModel = mongoose.model('Group', GroupSchema);
export type GroupDoc = InferSchemaType<typeof GroupSchema> & { _id: mongoose.Types.ObjectId };

// ---------- Member (anggota yang pernah terlihat) ----------
const MemberSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    platformUserId: { type: String, required: true },
    displayName: { type: String, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
MemberSchema.index({ platform: 1, groupId: 1, platformUserId: 1 }, { unique: true });
export const MemberModel = mongoose.model('Member', MemberSchema);

// ---------- Promise (janji) ----------
export const PROMISE_STATUS = ['pending_confirm', 'active', 'done', 'overdue', 'cancelled'] as const;
const PromiseSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    channelId: { type: String, required: true },
    sourceMessageId: { type: String, default: null },
    owner: { type: MemberRef, required: true },
    createdBy: { type: MemberRef, required: true },
    task: { type: String, required: true },
    deadline: { type: Date, default: null },
    deadlineText: { type: String, default: null },
    status: { type: String, enum: PROMISE_STATUS, default: 'pending_confirm' },
    stage: { type: String, enum: ['none', 'h2', 'h1', 'h0', 'overdue'], default: 'none' },
    source: { type: String, enum: ['llm', 'heuristic', 'manual', 'opportunity'], default: 'llm' },
    confirmedAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },
    // Langsung aktif tanpa klik konfirmasi. Selama pemilik belum pernah menyentuhnya (ownerTouched),
    // tagihan lewat deadline hanya lewat DM dan selalu ada tombol "Bukan janjiku".
    autoActivated: { type: Boolean, default: false },
    // Dicatat diam-diam saat mode pilot 'diam' (baseline): tidak pernah ditagih.
    shadow: { type: Boolean, default: false },
    // Tindak lanjut sekali saja: tanya ulang konfirmasi, dan tanya kabar sehari setelah lewat deadline.
    // Waktu bot bertanya "jadi?" (jam bot, ikut DEMO_TIME_SCALE — createdAt memakai jam sistem).
    askedAt: { type: Date, default: null },
    nudgedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    followedUpAt: { type: Date, default: null },
    ownerTouched: { type: Boolean, default: false },
  },
  { timestamps: true },
);
PromiseSchema.index({ status: 1, deadline: 1 });
PromiseSchema.index({ groupId: 1, status: 1 });
export const PromiseModel = mongoose.model('Promise', PromiseSchema);
export type PromiseDoc = InferSchemaType<typeof PromiseSchema> & { _id: mongoose.Types.ObjectId };

// ---------- Kas: bukti transfer (status bisa berubah) ----------
const KasProofSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    channelId: { type: String, required: true },
    member: { type: MemberRef, required: true },
    imageHash: { type: String, required: true },
    imagePHash: { type: String, default: null },
    nominal: { type: Number, default: null },
    transferDate: { type: String, default: null },
    bank: { type: String, default: null },
    sender: { type: String, default: null },
    recipient: { type: String, default: null },
    // refId mentah dihapus setelah ditinjau; hash-nya tetap untuk cek duplikat.
    refHash: { type: String, default: null },
    refId: { type: String, default: null },
    flags: { type: [String], default: [] },
    period: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    // Kartu sudah sampai ke bendahara/tim inti? null → scheduler mencoba kirim ulang (maks 5x).
    reviewSentAt: { type: Date, default: null },
    reviewAttempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
KasProofSchema.index({ groupId: 1, imageHash: 1 });
KasProofSchema.index({ groupId: 1, refId: 1 });
KasProofSchema.index({ groupId: 1, refHash: 1 });
export const KasProofModel = mongoose.model('KasProof', KasProofSchema);

// ---------- Kas: ledger (append-only) ----------
const TransactionSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    memberId: { type: String, default: null },
    memberName: { type: String, required: true },
    amount: { type: Number, required: true },
    kind: { type: String, enum: ['iuran', 'koreksi', 'pengeluaran', 'pemasukan'], required: true },
    period: { type: String, required: true },
    note: { type: String, default: '' },
    proofId: { type: Schema.Types.ObjectId, default: null },
    reversalOf: { type: Schema.Types.ObjectId, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
TransactionSchema.index({ groupId: 1, period: 1 });
const appendOnly = function () {
  throw new Error('Ledger append-only: koreksi = transaksi baru, bukan update/delete.');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  TransactionSchema.pre(op, appendOnly);
}
export const TransactionModel = mongoose.model('Transaction', TransactionSchema);

// ---------- Kas: jejak pengingat (biar tidak dobel) ----------
const KasReminderSchema = new Schema(
  {
    groupId: { type: String, required: true },
    period: { type: String, required: true },
    memberId: { type: String, required: true },
    stage: { type: String, required: true },
  },
  { timestamps: true },
);
KasReminderSchema.index({ groupId: 1, period: 1, memberId: 1, stage: 1 }, { unique: true });
export const KasReminderModel = mongoose.model('KasReminder', KasReminderSchema);

// ---------- Buffer pesan untuk rangkuman (TTL 48 jam) ----------
export const BUFFER_TTL_SECONDS = 48 * 3600;
const MessageBufferSchema = new Schema({
  groupId: { type: String, required: true },
  channelId: { type: String, required: true },
  // ID penulis untuk hak hapus data — nama tampilan bisa diganti/ditiru, jadi tidak dipakai sebagai kunci.
  authorId: { type: String, default: null },
  authorName: { type: String, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});
MessageBufferSchema.index({ createdAt: 1 }, { expireAfterSeconds: BUFFER_TTL_SECONDS });
MessageBufferSchema.index({ groupId: 1, createdAt: -1 });
export const MessageBufferModel = mongoose.model('MessageBuffer', MessageBufferSchema);

// ---------- Info lomba ----------
const OpportunitySchema = new Schema(
  {
    title: { type: String, required: true },
    organizer: { type: String, required: true },
    deadline: { type: Date, required: true },
    tags: { type: [String], default: [] },
    level: { type: String, default: 'SMA/SMK' },
    link: { type: String, required: true },
    description: { type: String, default: '' },
    sponsored: { type: Boolean, default: false },
    // null = kurasi global (seed / feed otomatis); selain itu hanya untuk server yang menambahkan.
    groupId: { type: String, default: null },
    addedBy: { type: String, default: 'seed' },
    kind: { type: String, enum: ['lomba', 'beasiswa'], default: 'lomba' },
    fee: { type: String, default: null },
    // Hasil baca link yang belum disetujui pengurus — tidak diposting/ditampilkan.
    draft: { type: Boolean, default: false },
    // Asal data: 'seed', 'manual', 'link', atau 'feed:<domain>'.
    source: { type: String, default: 'seed' },
  },
  { timestamps: true },
);
OpportunitySchema.index({ groupId: 1, title: 1 }, { unique: true });
OpportunitySchema.index({ link: 1 });
export const OpportunityModel = mongoose.model('Opportunity', OpportunitySchema);
export type OpportunityDoc = InferSchemaType<typeof OpportunitySchema> & { _id: mongoose.Types.ObjectId };

// Item feed yang sudah pernah dibaca (supaya tidak dibaca ulang tiap hari).
const FeedItemSchema = new Schema({ url: { type: String, required: true, unique: true }, feed: String, accepted: Boolean, seenAt: { type: Date, default: Date.now } });
FeedItemSchema.index({ seenAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });
export const FeedItemModel = mongoose.model('FeedItem', FeedItemSchema);

const OppPostSchema = new Schema(
  {
    groupId: { type: String, required: true },
    opportunityId: { type: Schema.Types.ObjectId, required: true },
    postedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
OppPostSchema.index({ groupId: 1, opportunityId: 1 }, { unique: true });
export const OppPostModel = mongoose.model('OppPost', OppPostSchema);

// ---------- Wawancara setup (sementara; hilang sendiri setelah 3 hari) ----------
const OnboardingSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    channelId: { type: String, required: true },
    step: { type: String, required: true },
    interviewerId: { type: String, default: null },
    data: {
      className: { type: String, default: null },
      majors: { type: [String], default: [] },
      speechLevel: { type: String, default: 'santai' },
      kasChannelId: { type: String, default: null },
      oppsChannelId: { type: String, default: null },
      kasAmount: { type: Number, default: 0 },
      kasPeriod: { type: String, default: 'bulanan' },
      treasurerId: { type: String, default: null },
      reviewChannelId: { type: String, default: null },
      reviewChannelPrivate: { type: Boolean, default: false },
    },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
OnboardingSchema.index({ platform: 1, groupId: 1 }, { unique: true });
OnboardingSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });
export const OnboardingModel = mongoose.model('Onboarding', OnboardingSchema);
export type OnboardingDoc = InferSchemaType<typeof OnboardingSchema> & { _id: mongoose.Types.ObjectId };

// ---------- WhatsApp: tombol & form yang menunggu balasan (pengganti komponen Discord) ----------
// WhatsApp tidak punya tombol untuk akun biasa → bot menulis "balas 1/2/3" dan menyimpan pilihan
// di sini, supaya balasan tetap dikenali setelah bot restart. Hilang sendiri setelah 7 hari.
const WaPromptSchema = new Schema({
  chatId: { type: String, required: true },
  messageId: { type: String, required: true },
  /** Kelas tempat aksi ini berlaku (chat pribadi bendahara tetap terikat ke kelasnya). */
  groupId: { type: String, required: true },
  actions: { type: [{ id: String, label: String, _id: false }], default: [] },
  form: {
    type: new Schema({ id: String, title: String, fields: { type: [{ id: String, label: String, required: Boolean, _id: false }], default: [] } }, { _id: false }),
    default: null,
  },
  createdAt: { type: Date, required: true, default: Date.now },
});
WaPromptSchema.index({ chatId: 1, messageId: 1 }, { unique: true });
WaPromptSchema.index({ chatId: 1, createdAt: -1 });
WaPromptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const WaPromptModel = mongoose.model('WaPrompt', WaPromptSchema);
export type WaPromptDoc = InferSchemaType<typeof WaPromptSchema> & { _id: mongoose.Types.ObjectId };

// ---------- Biaya LLM (ringkasan harian, tanpa isi pesan) ----------
const LlmUsageSchema = new Schema({
  day: { type: String, required: true }, // YYYY-MM-DD (WIB)
  model: { type: String, required: true },
  calls: { type: Number, default: 0 },
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
  /** Panggilan yang tidak melaporkan biaya (endpoint non-OpenRouter). */
  unpricedCalls: { type: Number, default: 0 },
  totalMs: { type: Number, default: 0 },
});
LlmUsageSchema.index({ day: 1, model: 1 }, { unique: true });
export const LlmUsageModel = mongoose.model('LlmUsage', LlmUsageSchema);

// ---------- Kesehatan bot: detak scheduler & catatan mati (keabsahan data pilot) ----------
const HeartbeatSchema = new Schema({ _id: { type: String }, lastTick: { type: Date, required: true }, startedAt: { type: Date, required: true } });
export const HeartbeatModel = mongoose.model('Heartbeat', HeartbeatSchema);

const DowntimeSchema = new Schema({ from: { type: Date, required: true }, to: { type: Date, required: true }, minutes: { type: Number, required: true } }, { timestamps: false });
DowntimeSchema.index({ from: 1 });
export const DowntimeModel = mongoose.model('Downtime', DowntimeSchema);

// ---------- Pengingat pribadi / kelas ("@MIC ingetin aku besok jam 7 …") ----------
const ReminderSchema = new Schema(
  {
    platform: { type: String, required: true },
    groupId: { type: String, required: true },
    channelId: { type: String, required: true },
    member: { type: MemberRef, required: true },
    target: { type: String, enum: ['self', 'group'], required: true },
    what: { type: String, required: true },
    at: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    cancelled: { type: Boolean, default: false },
  },
  { timestamps: true },
);
ReminderSchema.index({ sentAt: 1, cancelled: 1, at: 1 });
// Isi pengingat bisa pribadi → hapus sendiri 30 hari setelah waktunya.
ReminderSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export const ReminderModel = mongoose.model('Reminder', ReminderSchema);
export type ReminderDoc = InferSchemaType<typeof ReminderSchema> & { _id: mongoose.Types.ObjectId };

// ---------- Jadwal tugas berkala (mis. ambil feed lomba harian) ----------
const JobRunSchema = new Schema({ _id: { type: String }, lastRunAt: { type: Date, required: true }, note: { type: String, default: '' } });
export const JobRunModel = mongoose.model('JobRun', JobRunSchema);
