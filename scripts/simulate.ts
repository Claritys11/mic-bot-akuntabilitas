// Simulasi end-to-end core + MongoDB tanpa Discord. Jalankan: bun simulate
// Pakai database terpisah (mic_sim) yang dihapus di awal.
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.ts';
import { createCore } from '../src/core/index.ts';
import { seedOpportunities } from '../src/core/opps/service.ts';
import { Clock, formatWIB, setClock } from '../src/core/time.ts';
import type { Context, IncomingMessage, Member, MessageBody, OutgoingMessage, Reply } from '../src/core/types.ts';
import { connectDb } from '../src/db/connect.ts';
import { disabledLLM } from '../src/llm/provider.ts';
import { OpenRouterProvider } from '../src/llm/openrouter.ts';

class FakeClock extends Clock {
  constructor(public t: Date) {
    super(1);
  }
  override now() {
    return new Date(this.t);
  }
}

const config = loadConfig();
const useLLM = process.argv.includes('--llm');
const llm = useLLM ? OpenRouterProvider.fromConfig(config) : disabledLLM;
const clock = new FakeClock(new Date('2026-10-22T03:00:00Z')); // Kamis 10:00 WIB
setClock(clock);

const uri = config.mongoUri.replace(/\/[^/?]*(\?|$)/, '/mic_sim$1');
await connectDb(uri);
await mongoose.connection.dropDatabase();
await mongoose.connection.syncIndexes();
const core = createCore(llm);

const G = 'guild-1';
const CH = 'ch-umum';
const KAS = 'ch-kas';
const LOMBA = 'ch-lomba';
const member = (id: string, name: string): Member => ({ platform: 'discord', platformUserId: id, groupId: G, displayName: name });
const ani = member('u-ani', 'Ani');
const budi = member('u-budi', 'Budi');
const ketua = member('u-ketua', 'Ketua');
const sari = member('u-sari', 'Sari');
const ctx = (actor: Member, channelId = CH, isAdmin = false): Context => ({ platform: 'discord', groupId: G, channelId, actor, isAdmin });

let msgSeq = 0;
const say = (author: Member, text: string, channelId = CH, attachments: IncomingMessage['attachments'] = []): IncomingMessage => ({
  id: `m${++msgSeq}`,
  platform: 'discord',
  groupId: G,
  channelId,
  author,
  text,
  attachments,
  mentions: [],
  timestamp: new Date(),
});

const names: Record<string, string> = { 'u-ani': 'Ani', 'u-budi': 'Budi', 'u-ketua': 'Ketua' };
const show = (s: string) => s.replace(/\{\{@([^}]+)\}\}/g, (_, id: string) => `@${names[id] ?? id}`).replace(/\{\{#([^}]+)\}\}/g, '#$1');
function printBody(b: MessageBody, indent = '  ') {
  if (b.text) console.log(`${indent}${show(b.text)}`);
  if (b.card) {
    console.log(`${indent}┌ ${show(b.card.title)}`);
    if (b.card.description) console.log(`${indent}│ ${show(b.card.description).replace(/\n/g, `\n${indent}│ `)}`);
    for (const f of b.card.fields ?? []) console.log(`${indent}│ ${f.name}: ${show(f.value).replace(/\n/g, ' / ')}`);
    if (b.card.footer) console.log(`${indent}└ ${show(b.card.footer)}`);
  }
  if (b.actions?.length) console.log(`${indent}[${b.actions.map((a) => a.label).join('] [')}]`);
  if (b.file) console.log(`${indent}📎 ${b.file.name}\n${indent}${b.file.content.replace(/\n/g, `\n${indent}`)}`);
}
function printOut(list: OutgoingMessage[]) {
  for (const m of list) {
    const to = m.to.kind === 'dm' ? `DM → ${m.to.member.displayName}` : m.to.kind === 'thread' ? `thread "${m.to.name}"` : `#${m.to.channelId}`;
    console.log(` → ${to}`);
    printBody(m);
  }
}
function printReply(r: Reply) {
  if (r.form) console.log(`  [FORM] ${r.form.title}: ${r.form.fields.map((f) => `${f.label}="${f.value ?? ''}"`).join(', ')}`);
  if (r.update) {
    console.log('  (pesan diperbarui)');
    printBody(r.update);
  }
  if (r.reply) {
    console.log(`  (balasan${r.reply.private ? ' privat' : ''})`);
    printBody(r.reply);
  }
  if (r.messages) printOut(r.messages);
}
const step = (t: string) => console.log(`\n━━ ${t}  [${formatWIB(clock.now())}]`);
const hasAction = (out: OutgoingMessage[] | MessageBody | undefined, prefix: string) =>
  (Array.isArray(out) ? out : out ? [out] : []).flatMap((m) => m.actions ?? []).some((a) => a.id.startsWith(prefix));
const actionOf = (out: OutgoingMessage[] | MessageBody | undefined, label: string) => {
  const list = Array.isArray(out) ? out : out ? [out] : [];
  const a = list.flatMap((m) => m.actions ?? []).find((x) => x.label.includes(label) || x.id.startsWith(label));
  if (!a) throw new Error(`Tombol "${label}" tidak ditemukan`);
  return a.id;
};

// ---- M0: setup lewat wawancara ----
core.registerPlatform('discord', {
  createChannel: async (_g, name) => (name === 'kas-kelas' ? KAS : LOMBA),
  listMembers: async () => [ani, budi, ketua],
});
const click = async (actor: Member, actionId: string, isAdmin = false) =>
  printReply(await core.onAction({ ...ctx(actor, CH, isAdmin), actionId, messageId: 'm-ob' }));
const answer = async (author: Member, text: string, extra: Partial<IncomingMessage> = {}) => printOut(await core.onMessage({ ...say(author, text), ...extra }));

step('Bot masuk server → menyapa');
printOut(await core.onJoin({ platform: 'discord', groupId: G, channelId: CH }));
step('Budi (bukan admin) klik mulai → ditolak');
await click(budi, 'ob:start');
step('Ketua (admin) klik 🚀 Ayo mulai');
await click(ketua, 'ob:start', true);
step('Budi ikut jawab → diabaikan');
await answer(budi, 'XI ngawur');
step('Ketua: nama kelas');
await answer(ketua, 'kelas XI International');
step('Ketua: jurusan');
await answer(ketua, 'RPL, TKJ, dan PG');
step('Ketua pilih gaya bahasa: sopan');
await click(ketua, 'ob:tutur:sopan', true);
step('Ketua: ✨ Bikinin channel');
await click(ketua, 'ob:ch:new', true);
step('Ketua: kas');
await answer(ketua, '10rb per bulan');
step('Ketua tag bendahara');
await answer(ketua, '@Ketua aja', { mentions: [ketua] });

// ---- M1: janji ----
step('Obrolan biasa (tidak lolos prefilter)');
printOut(await core.onMessage(say(budi, 'wkwk iya bener')));
step('Ani: "aku yang bikin PPT ya, Jumat jadi"');
const det = await core.onMessage(say(ani, 'aku yang bikin PPT ya, Jumat jadi'));
printOut(det);
if (hasAction(det, 'p:ok:')) {
  step('Budi coba konfirmasi janji Ani (harus ditolak)');
  printReply(await core.onAction({ ...ctx(budi), actionId: actionOf(det, 'p:ok:'), messageId: 'bot1' }));
  step('Ani klik ✅ Konfirmasi');
  printReply(await core.onAction({ ...ctx(ani), actionId: actionOf(det, 'p:ok:'), messageId: 'bot1' }));
} else {
  // Dengan LLM: janji jelas + ada deadline langsung aktif (auto-aktif).
  step('Janji langsung aktif → Budi coba klik "Bukan janji" milik Ani (harus ditolak)');
  printReply(await core.onAction({ ...ctx(budi), actionId: actionOf(det, 'p:no:'), messageId: 'bot1' }));
  step('Ketua: "aku yang bawa proyektor besok" → auto-aktif, lalu Ketua balas bot "bukan" → batal');
  const auto2 = await core.onMessage(say(ketua, 'aku yang bawa proyektor besok'));
  printOut(auto2);
  if (!hasAction(auto2, 'p:ok:')) printOut(await core.onMessage({ ...say(ketua, 'bukan'), mentionsBot: true }));
}

step('Sari: "aku yang beli kertas HVS" → bot tanya, Sari jawab ketik "jadi dong, besok"');
printOut(await core.onMessage(say(sari, 'aku yang beli kertas HVS ya')));
printOut(await core.onMessage(say(sari, 'jadi dong, besok')));

step('Budi: "ada tugas gak nih?" → bot menjawab dari catatan');
printOut(await core.onMessage(say(budi, 'ada tugas gak nih?')));

const tick = async (label: string, iso: string) => {
  clock.t = new Date(iso);
  step(label);
  const out = await core.tick();
  if (!out.length) console.log('  (tidak ada pesan)');
  printOut(out);
  return out;
};
await tick('Tick (Kamis 11:00) — H-2 sudah lewat saat konfirmasi', '2026-10-22T04:00:00Z');
await tick('Tick Jumat 17:30 — H-0', '2026-10-23T10:30:00Z');
const overdue = await tick('Tick Jumat 21:30 — lewat deadline → umumkan ke grup', '2026-10-23T14:30:00Z');
step('Ani klik ✅ Sudah selesai (terlambat)');
printReply(await core.onAction({ ...ctx(ani), actionId: actionOf(overdue, 'p:done:'), messageId: 'bot2' }));

clock.t = new Date('2026-10-24T02:00:00Z');
step('Budi: "biar aku aja yang print laporan, besok sore" → ✏️ ubah');
const det2 = await core.onMessage(say(budi, 'biar aku aja yang print laporan, besok sore'));
printOut(det2);
const edit = await core.onAction({ ...ctx(budi), actionId: actionOf(det2, 'Ubah'), messageId: 'bot3' });
printReply(edit);
printReply(await core.onForm({ ...ctx(budi), formId: edit.form!.id, values: { task: 'print & jilid laporan', deadline: 'senin jam 7 pagi' } }));
if (hasAction(det2, 'p:ok:')) printReply(await core.onAction({ ...ctx(budi), actionId: actionOf(det2, 'p:ok:'), messageId: 'bot3' }));
step('/janji list');
printReply(await core.onCommand({ ...ctx(ani), name: 'janji.list', options: {} }));
step('/rapor-kelas');
printReply(await core.onCommand({ ...ctx(ani), name: 'rapor-kelas', options: {} }));

// ---- M2: kas ----
step('/kas atur 10000 bulanan, bendahara Ketua');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'kas.atur', options: { nominal: 10000, periode: 'bulanan', bendahara: ketua.platformUserId } }));
const fakeImage = (seed: string) => [{ name: 'bukti.png', contentType: 'image/png', getData: async () => new TextEncoder().encode(`fake-image-${seed}`) }];
step('Ani kirim foto bukti transfer di #kas');
const proof = await core.onMessage(say(ani, '', KAS, fakeImage('ani')));
printOut(proof);
step('Ketua klik ✅ Setujui (nominal tak terbaca → form)');
const appr = await core.onAction({ ...ctx(ketua, KAS), actionId: actionOf(proof, 'Setujui'), messageId: 'bot4' });
printReply(appr);
printReply(await core.onForm({ ...ctx(ketua, KAS), formId: appr.form!.id, values: { nominal: '10.000' } }));
step('Budi kirim gambar yang SAMA (duplikat)');
printOut(await core.onMessage(say(budi, '', KAS, fakeImage('ani'))));
step('/kas rekap');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'kas.rekap', options: {} }));
step('/kas ekspor');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'kas.ekspor', options: {} }));
await tick('Tick 30 Okt — pengingat kas akhir periode (DM yang belum bayar)', '2026-10-30T03:00:00Z');

// ---- M3: rangkuman ----
step('/rangkum 3');
printReply(await core.onCommand({ ...ctx(ani), name: 'rangkum', options: { jam: 3 } }));

// ---- M4: info lomba ----
console.log(`\n(seed ${await seedOpportunities(clock.now())} info lomba)`);
const posts = await tick('Tick 31 Okt 10:00 — posting info lomba', '2026-10-31T03:00:00Z');
await tick('Tick lagi — posting ke-2 minggu ini', '2026-10-31T04:00:00Z');
await tick('Tick lagi — sudah 2 minggu ini, tidak posting', '2026-10-31T05:00:00Z');
step('Budi klik 👥 Bentuk tim');
printReply(await core.onAction({ ...ctx(budi, LOMBA), actionId: actionOf(posts, 'Bentuk tim'), messageId: 'bot5' }));

// ---- M6: pilot mode diam (baseline) ----
step('/pilot mode diam (Ketua, admin)');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'pilot.mode', options: { mode: 'diam' } }));
step('Budi: "aku yang rangkum bab 4, senin" → mode diam: bot TIDAK membalas, tapi mencatat');
const silent = await core.onMessage(say(budi, 'aku yang rangkum bab 4, senin'));
console.log(silent.length ? '  ❌ bot membalas saat diam!' : '  (diam ✓)');
step('/pilot ekspor');
const exp = await core.onCommand({ ...ctx(ketua, CH, true), name: 'pilot.ekspor', options: {} });
printReply(exp);
console.log(exp.reply?.file?.content.split('\n').filter((l) => l.includes('rangkum bab 4')).join('\n') || '  ❌ janji diam tidak tercatat');
step('/pilot mode aktif');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'pilot.mode', options: { mode: 'aktif' } }));

step('/pilot mode jeda (rem darurat) → bot berhenti total');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'pilot.mode', options: { mode: 'jeda' } }));
const paused = await core.onMessage({ ...say(ani, '@MIC ada tugas gak nih?'), mentionsBot: true });
console.log(paused.length ? '  ❌ bot membalas saat jeda!' : '  (jeda ✓ — tidak membalas)');
const pausedTick = await core.tick();
console.log(pausedTick.some((m) => 'channelId' in m.to && m.to.channelId === CH) ? '  ❌ ada pesan terjadwal saat jeda' : '  (tidak ada tagihan/posting ke grup saat jeda ✓)');
printReply(await core.onCommand({ ...ctx(ketua, CH, true), name: 'pilot.mode', options: { mode: 'aktif' } }));

step('Sari: /data hapus-saya → konfirmasi → hapus');
const del = await core.onCommand({ ...ctx(sari), name: 'data.hapus-saya', options: {} });
printReply(del);
step('Budi coba menekan tombol hapus milik Sari (harus ditolak)');
printReply(await core.onAction({ ...ctx(budi), actionId: actionOf(del.reply, 'hapus permanen'), messageId: 'bot6' }));
step('Sari menekan 🗑️ Ya, hapus permanen');
printReply(await core.onAction({ ...ctx(sari), actionId: actionOf(del.reply, 'hapus permanen'), messageId: 'bot6' }));
const left = await mongoose.connection.collection('promises').countDocuments({ 'owner.platformUserId': sari.platformUserId });
const members = await mongoose.connection.collection('members').countDocuments({ platformUserId: sari.platformUserId });
console.log(left || members ? `  ❌ masih ada ${left} janji / ${members} data anggota Sari` : '  (janji & data anggota Sari terhapus ✓)');

console.log(`\nLLM usage: ${JSON.stringify(llm.usage())}`);
await mongoose.disconnect();
