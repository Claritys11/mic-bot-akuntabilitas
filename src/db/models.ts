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
    kas: {
      amount: { type: Number, default: 0 },
      period: { type: String, enum: ['mingguan', 'bulanan'], default: 'bulanan' },
      treasurerId: { type: String, default: null },
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
    nominal: { type: Number, default: null },
    transferDate: { type: String, default: null },
    bank: { type: String, default: null },
    sender: { type: String, default: null },
    refId: { type: String, default: null },
    flags: { type: [String], default: [] },
    period: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
KasProofSchema.index({ groupId: 1, imageHash: 1 });
KasProofSchema.index({ groupId: 1, refId: 1 });
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
    addedBy: { type: String, default: 'seed' },
  },
  { timestamps: true },
);
OpportunitySchema.index({ title: 1 }, { unique: true });
export const OpportunityModel = mongoose.model('Opportunity', OpportunitySchema);
export type OpportunityDoc = InferSchemaType<typeof OpportunitySchema> & { _id: mongoose.Types.ObjectId };

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
