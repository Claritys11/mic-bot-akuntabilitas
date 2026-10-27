import { GroupModel, OnboardingModel, type OnboardingDoc } from '../../db/models.ts';
import { getGroup, setupGroup, upsertMembers } from '../groups.ts';
import { rupiah, type KasPeriod } from '../kas/ledger.ts';
import { now } from '../time.ts';
import {
  channelRef,
  mention,
  type Action,
  type ActionEvent,
  type IncomingMessage,
  type JoinEvent,
  type OutgoingMessage,
  type PlatformOps,
  type Reply,
  type SpeechLevel,
} from '../types.ts';
import { ensureReviewChannel } from '../kas/review.ts';
import { parseClassName, parseKas, parseMajors } from './parse.ts';

// Setup kelas lewat wawancara santai, bukan slash command (prinsip "tidak menambah langkah").
// Urutan: sapa → nama kelas → jurusan → gaya bahasa → channel → kas → bendahara → tempat cek bukti → selesai.

type Step = 'greet' | 'kelas' | 'jurusan' | 'tutur' | 'channel' | 'kas' | 'bendahara' | 'review';

const say = (channelId: string, text: string, actions?: Action[]): OutgoingMessage => ({ to: { kind: 'channel', channelId }, text, actions });
const deny = (text: string): Reply => ({ reply: { text, private: true } });

const QUESTIONS: Record<Exclude<Step, 'greet'>, (o: OnboardingDoc, ops: PlatformOps) => { text: string; actions?: Action[] }> = {
  kelas: () => ({ text: 'Sip! Pertama dulu nih — ini kelas apa? Tulis aja namanya, misal **XI International** 😄' }),
  jurusan: (o) => ({
    text: `Oke, **${o.data?.className}** 👍 Jurusannya apa aja? Kalau campur, pisahin pakai koma ya (misal: RPL, TKJ, PG).`,
  }),
  tutur: () => ({
    text:
      'Kalau aku lagi ngingetin atau nagih, enaknya gaya ngomongku gimana?\n' +
      '• **Santai** — "eh jangan lupa ya, besok deadline 😄"\n' +
      '• **Sopan** — "mohon diingat, tenggatnya besok 🙏"\n' +
      '• **Krama** — "nyuwun pangapunten, mbenjing sampun wekdalipun 🙏"',
    actions: [
      { id: 'ob:tutur:santai', label: '😄 Santai', kind: 'primary' },
      { id: 'ob:tutur:sopan', label: '🙂 Sopan', kind: 'secondary' },
      { id: 'ob:tutur:krama', label: '🙏 Krama', kind: 'secondary' },
    ],
  }),
  channel: (_o, ops) =>
    ops.createChannel
      ? {
          text: 'Biar rapi, aku butuh tempat buat **bukti transfer kas** sama **info lomba**. Mau aku bikinin channel baru (#kas-kelas & #info-lomba)?',
          actions: [
            { id: 'ob:ch:new', label: '✨ Bikinin aja', kind: 'primary' },
            { id: 'ob:ch:here', label: '📍 Pakai channel ini', kind: 'secondary' },
            { id: 'ob:ch:skip', label: 'Nanti aja', kind: 'secondary' },
          ],
        }
      : {
          text: 'Bukti transfer kas & info lomba aku taruh di grup ini aja ya.',
          actions: [{ id: 'ob:ch:here', label: '👍 Oke', kind: 'primary' }],
        },
  kas: () => ({
    text: 'Kelas kalian ada uang kas nggak? Kalau ada, berapa dan tiap kapan? (misal: **5rb seminggu** atau **20rb per bulan**)',
    actions: [{ id: 'ob:kas:none', label: 'Nggak ada kas', kind: 'secondary' }],
  }),
  bendahara: (o) => ({
    text: `Catat: ${rupiah(o.data?.kasAmount ?? 0)} ${o.data?.kasPeriod === 'mingguan' ? 'per minggu' : 'per bulan'} 📝 Terus bendaharanya siapa? Tag aja orangnya ya.`,
    actions: [{ id: 'ob:bend:me', label: '🙋 Aku sendiri', kind: 'secondary' }],
  }),
  review: () => ({
    text:
      'Terakhir: bukti transfer kas enaknya dicek bendahara di mana?\n' +
      '• **Channel tim inti** — aku cari channel pengurus yang sudah ada, kalau belum ada aku buatin (privat, cuma pengurus yang bisa lihat) 🔒\n' +
      '• **DM bendahara** — langsung ke chat pribadi bendahara',
    actions: [
      { id: 'ob:rev:channel', label: '🔒 Channel tim inti', kind: 'primary' },
      { id: 'ob:rev:dm', label: '📩 DM bendahara', kind: 'secondary' },
    ],
  }),
};

/** Setelah bendahara dipilih: tanya tempat cek bukti kalau platform punya channel; kalau tidak, langsung selesai. */
async function afterTreasurer(o: OnboardingDoc, ops: PlatformOps): Promise<OutgoingMessage[]> {
  if (ops.findChannel || ops.createPrivateChannel) return [ask(await advance(o._id, 'review'), 'review', ops)];
  return finish(o, ops);
}

function ask(o: OnboardingDoc, step: Exclude<Step, 'greet'>, ops: PlatformOps): OutgoingMessage {
  const q = QUESTIONS[step](o, ops);
  return say(o.channelId, q.text, q.actions);
}

async function advance(id: unknown, step: Step, set: Record<string, unknown> = {}): Promise<OnboardingDoc> {
  const doc = await OnboardingModel.findByIdAndUpdate(id, { $set: { ...set, step, updatedAt: now() } }, { returnDocument: 'after' }).lean<OnboardingDoc>();
  return doc!;
}

function greeting(channelId: string, redo: boolean): OutgoingMessage {
  return say(
    channelId,
    redo
      ? 'Oke, kita atur ulang ya 🔧 Admin kelas, klik tombol di bawah buat mulai.'
      : 'Halo semuanya! 👋 Aku **MIC-Bot**, asisten kelas yang bakal bantu ngingetin janji, nyatet kas, sama bagi info lomba.\n' +
          'Biar bisa kerja, aku mau kenalan dulu sama kelas ini — cuma beberapa pertanyaan kok. Admin kelas, klik tombol di bawah ya!',
    [{ id: 'ob:start', label: '🚀 Ayo mulai', kind: 'primary' }],
  );
}

/** Mulai (atau ulang) wawancara di channel ini. */
export async function startOnboarding(platform: JoinEvent['platform'], groupId: string, channelId: string, redo = false): Promise<OutgoingMessage[]> {
  await OnboardingModel.findOneAndUpdate(
    { platform, groupId },
    { $set: { channelId, step: 'greet', interviewerId: null, data: {}, updatedAt: now() } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  return [greeting(channelId, redo)];
}

/** Bot baru masuk / menyala di grup yang belum diatur → sapa sekali saja. */
export async function onJoin(ev: JoinEvent): Promise<OutgoingMessage[]> {
  if (await getGroup(ev.platform, ev.groupId)) return [];
  if (await OnboardingModel.exists({ platform: ev.platform, groupId: ev.groupId })) return [];
  return startOnboarding(ev.platform, ev.groupId, ev.channelId);
}

const SETUP_WORDS = /\b(setup|set ?up|atur(?: ulang)?|setting|konfigurasi|mulai)\b/i;

/**
 * Dipanggil sebelum alur biasa. Mengembalikan null kalau pesan ini bukan urusan wawancara.
 */
export async function handleOnboardingMessage(msg: IncomingMessage, ops: PlatformOps, configured: boolean): Promise<OutgoingMessage[] | null> {
  const o = await OnboardingModel.findOne({ platform: msg.platform, groupId: msg.groupId }).lean<OnboardingDoc>();

  if (msg.mentionsBot) {
    // "@MIC-Bot setup" oleh admin → mulai/ulang. Belum diatur & bot disapa → tawarkan setup.
    if (msg.authorIsAdmin && SETUP_WORDS.test(msg.text)) return startOnboarding(msg.platform, msg.groupId, msg.channelId, configured);
    if (!configured && (!o || o.step === 'greet')) return startOnboarding(msg.platform, msg.groupId, msg.channelId);
  }

  if (!o || o.channelId !== msg.channelId || o.interviewerId !== msg.author.platformUserId) return null;
  const text = msg.text.trim();

  if (o.step === 'kelas') {
    const className = parseClassName(text);
    if (!className) return [say(o.channelId, 'Hmm, namanya kependekan 😅 Coba tulis lengkap, misal **XI International**.')];
    return [ask(await advance(o._id, 'jurusan', { 'data.className': className }), 'jurusan', ops)];
  }
  if (o.step === 'jurusan') {
    const majors = parseMajors(text);
    if (!majors.length) return [say(o.channelId, 'Aku belum nangkep jurusannya 🤔 Tulis singkatannya aja, misal **RPL, TKJ, PG**.')];
    const next = await advance(o._id, 'tutur', { 'data.majors': majors });
    return [say(o.channelId, `Mantap, ${majors.join(', ')} 🔥`), ask(next, 'tutur', ops)];
  }
  if (o.step === 'kas') {
    const kas = parseKas(text);
    if (kas === 'none') return finish(await advance(o._id, 'kas', { 'data.kasAmount': 0 }), ops);
    if (!kas) return [say(o.channelId, 'Nominalnya belum kebaca 😅 Coba tulis kayak **5rb seminggu** atau **20000 per bulan**.')];
    const next = await advance(o._id, 'bendahara', { 'data.kasAmount': kas.amount, 'data.kasPeriod': kas.period });
    return [ask(next, 'bendahara', ops)];
  }
  if (o.step === 'bendahara') {
    const t = msg.mentions[0];
    if (!t) return [say(o.channelId, 'Tag orangnya ya (ketik @ lalu pilih namanya), atau klik **Aku sendiri** 😄')];
    return afterTreasurer(await advance(o._id, 'bendahara', { 'data.treasurerId': t.platformUserId }), ops);
  }
  return null;
}

export async function handleOnboardingAction(ev: ActionEvent, ops: PlatformOps): Promise<Reply> {
  const o = await OnboardingModel.findOne({ platform: ev.platform, groupId: ev.groupId }).lean<OnboardingDoc>();
  if (!o) return deny('Sesi setup ini sudah selesai atau kedaluwarsa. Tag aku + "setup" buat mulai lagi ya.');
  if (!ev.isAdmin && o.interviewerId !== ev.actor.platformUserId) return deny('Yang bisa ngatur kelas cuma admin server ya 🙏');

  const [, verb, arg] = ev.actionId.split(':');
  // Pertanyaan tetap terlihat; tombol diganti kartu jawaban.
  const done = (label: string) => ({ actions: [] as Action[], card: { title: label, tone: 'success' as const } });

  if (verb === 'start' && o.step === 'greet') {
    const next = await advance(o._id, 'kelas', { interviewerId: ev.actor.platformUserId });
    return { update: { text: `${mention(ev.actor)} siap ngatur kelas ini 🙌`, actions: [] }, messages: [ask(next, 'kelas', ops)] };
  }
  if (verb === 'tutur' && o.step === 'tutur' && (arg === 'santai' || arg === 'sopan' || arg === 'krama')) {
    const next = await advance(o._id, 'channel', { 'data.speechLevel': arg });
    return { update: done(`Gaya bahasa: ${arg}`), messages: [ask(next, 'channel', ops)] };
  }
  if (verb === 'ch' && o.step === 'channel') {
    let kasChannelId: string | null = null;
    let oppsChannelId: string | null = null;
    let note = 'Oke, channel-nya nanti aja. Bisa diatur ulang kapan pun 👍';
    if (arg === 'here') {
      kasChannelId = oppsChannelId = o.channelId;
      note = `Oke, semua aku taruh di ${channelRef(o.channelId)} 👍`;
    } else if (arg === 'new' && ops.createChannel) {
      [kasChannelId, oppsChannelId] = await Promise.all([
        ops.createChannel(ev.groupId, 'kas-kelas', 'Kirim foto bukti transfer kas di sini — MIC-Bot yang nyatet 🧾', o.channelId),
        ops.createChannel(ev.groupId, 'info-lomba', 'Info lomba & beasiswa yang cocok buat kelas ini 🏆', o.channelId),
      ]);
      note =
        kasChannelId && oppsChannelId
          ? `Udah jadi: ${channelRef(kasChannelId)} sama ${channelRef(oppsChannelId)} ✨`
          : 'Waduh, aku nggak punya izin bikin channel 😢 Sementara aku pakai channel ini dulu ya.';
      kasChannelId ??= o.channelId;
      oppsChannelId ??= o.channelId;
    }
    const next = await advance(o._id, 'kas', { 'data.kasChannelId': kasChannelId, 'data.oppsChannelId': oppsChannelId });
    return { update: done('Channel beres'), messages: [say(o.channelId, note), ask(next, 'kas', ops)] };
  }
  if (verb === 'kas' && arg === 'none' && o.step === 'kas') {
    const out = await finish(await advance(o._id, 'kas', { 'data.kasAmount': 0 }), ops);
    return { update: done('Tanpa kas'), messages: out };
  }
  if (verb === 'bend' && arg === 'me' && o.step === 'bendahara') {
    const out = await afterTreasurer(await advance(o._id, 'bendahara', { 'data.treasurerId': ev.actor.platformUserId }), ops);
    return { update: done('Bendahara dicatat'), messages: out };
  }
  if (verb === 'rev' && o.step === 'review') {
    if (arg === 'dm') return { update: done('Bukti kas dicek lewat DM bendahara'), messages: await finish(o, ops) };
    const ch = await ensureReviewChannel(ops, {
      groupId: o.groupId,
      nearChannelId: o.channelId,
      allowUserIds: [o.data?.treasurerId ?? '', o.interviewerId ?? '', ev.actor.platformUserId],
    });
    const next = ch ? await advance(o._id, 'review', { 'data.reviewChannelId': ch.channelId, 'data.reviewChannelPrivate': ch.private }) : o;
    const note = !ch
      ? 'Waduh, aku nggak bisa bikin channel (izin Manage Channels belum ada) 😢 Sementara bukti dicek lewat DM bendahara ya.'
      : ch.created
        ? `Udah aku buatin ${channelRef(ch.channelId)} 🔒 — cuma kamu & bendahara yang bisa lihat (admin server juga). Tambah pengurus lain lewat pengaturan channel.`
        : `Aku pakai ${channelRef(ch.channelId)} yang sudah ada${ch.private ? ' 🔒' : ' — tapi channel ini kelihatan semua anggota, jadi yang bisa menyetujui tetap cuma bendahara & admin'}.`;
    return { update: done(ch ? 'Channel tim inti siap' : 'Lewat DM bendahara'), messages: [say(o.channelId, note), ...(await finish(next, ops))] };
  }
  return deny('Tombol ini udah lewat 😅 Lanjut jawab pertanyaan terakhir ya.');
}

async function finish(o: OnboardingDoc, ops: PlatformOps): Promise<OutgoingMessage[]> {
  const d = o.data!;
  const ctx = { platform: o.platform as JoinEvent['platform'], groupId: o.groupId };
  const g = await setupGroup(ctx, {
    className: d.className ?? 'Kelas',
    major: d.majors.length ? d.majors.join(', ') : 'UMUM',
    speechLevel: (d.speechLevel ?? 'santai') as SpeechLevel,
    mainChannelId: o.channelId,
    kasChannelId: d.kasChannelId,
    oppsChannelId: d.oppsChannelId,
  });
  await GroupModel.updateOne(
    { _id: g._id },
    {
      $set: {
        'kas.amount': d.kasAmount ?? 0,
        'kas.period': (d.kasPeriod ?? 'bulanan') as KasPeriod,
        'kas.treasurerId': d.treasurerId ?? null,
        'kas.reviewChannelId': d.reviewChannelId ?? null,
        'kas.reviewChannelPrivate': d.reviewChannelPrivate ?? false,
      },
      // Yang mengatur setup ikut tim inti (boleh menyetujui bukti) selain bendahara.
      ...(o.interviewerId ? { $addToSet: { 'kas.reviewerIds': o.interviewerId } } : {}),
    },
  );
  if (ops.listMembers) await upsertMembers(await ops.listMembers(o.groupId)).catch(() => undefined);
  await OnboardingModel.deleteOne({ _id: o._id });

  const kasLine = d.kasAmount
    ? `${rupiah(d.kasAmount)} ${d.kasPeriod === 'mingguan' ? 'per minggu' : 'per bulan'}${d.treasurerId ? `, bendahara ${mention({ platformUserId: d.treasurerId })}` : ''}`
    : '—';
  return [
    {
      to: { kind: 'channel', channelId: o.channelId },
      text: 'Beres! 🎉 Makasih udah ngenalin kelasnya.',
      card: {
        title: `✅ ${g.className} siap`,
        tone: 'success',
        fields: [
          { name: 'Jurusan', value: g.major, inline: true },
          { name: 'Gaya bahasa', value: g.speechLevel, inline: true },
          { name: 'Kas', value: kasLine, inline: true },
          { name: 'Bukti kas', value: d.kasChannelId ? channelRef(d.kasChannelId) : '—', inline: true },
          ...(d.kasAmount ? [{ name: 'Dicek bendahara di', value: d.reviewChannelId ? channelRef(d.reviewChannelId) : 'DM bendahara', inline: true }] : []),
          { name: 'Info lomba', value: d.oppsChannelId ? channelRef(d.oppsChannelId) : '—', inline: true },
        ],
        footer: 'Mau ganti? Tag aku + "setup ulang".',
      },
    },
    say(
      o.channelId,
      'Cara pakainya gampang, ngobrol biasa aja:\n' +
        '• Kalau ada yang bilang _"aku yang bikin PPT, Jumat jadi"_, aku catat terus aku ingetin pas mau deadline (kalau kurang jelas, aku tanya dulu; salah tangkap? balas aja "bukan").\n' +
        (d.kasAmount ? `• Bayar kas? Kirim foto bukti transfer di ${channelRef(d.kasChannelId ?? o.channelId)}, nanti bendahara tinggal klik setujui.\n` : '') +
        '• Info lomba yang cocok bakal aku share maksimal 2x seminggu.\n' +
        'Slash command (`/janji`, `/kas`, `/rangkum`) tetap ada kalau butuh 😉',
    ),
  ];
}
