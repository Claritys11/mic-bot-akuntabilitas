import { GroupModel, SheetLinkModel, type GroupDoc, type SheetLinkDoc } from '../../db/models.ts';
import { PRIVATE_FALLBACK } from '../billing/templates.ts';
import { getGroup, NOT_SETUP_TEXT } from '../groups.ts';
import { inQuietHours } from '../quiet.ts';
import { audit } from '../team/audit.ts';
import { can } from '../team/roles.ts';
import { now } from '../time.ts';
import { mention, sanitize, type Action, type ActionEvent, type Member, type OutgoingMessage, type Platform, type Reply, type SpeechLevel } from '../types.ts';
import { KAS_TABS } from './sheet.ts';

// Bot yang memulai laporan kas Google Sheets: tawarkan sekali ke bendahara/tim inti → tombol →
// login Google lewat kode → bot membuat sheet di Drive pengurus sendiri → link dikirim lewat DM.
// Sheet ada di Drive PRIBADI pemiliknya → kalau dia bukan pengurus kas lagi, bot berhenti menulis (ownerStillAllowed).
// Jaringan tidak dipanggil di sini — adapter memberi `SheetLinker` (lihat src/integrations/google/oauth.ts).

export interface SheetLinker {
  start(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>;
  poll(deviceCode: string): Promise<{ status: 'ok'; credential: string } | { status: 'pending' | 'slow_down' | 'denied' | 'expired' } | { status: 'error'; message: string }>;
  createSheet(credential: string, title: string, tabs: readonly string[]): Promise<{ id: string; title: string }>;
  revoke(credential: string): Promise<void>;
}

// ID kelas ikut di tombol: tombol di DM tidak membawa konteks server.
type Actor = { platformUserId: string; displayName: string };
type Link = Omit<SheetLinkDoc, 'actor'> & { actor: Actor };

export const SHEET_LINK_IDS = { start: (groupId: string) => `k:gs:start:${groupId}`, later: (groupId: string) => `k:gs:later:${groupId}` };
const OFFER_AFTER_MS = 2 * 60_000; // jangan langsung menyela wawancara setup

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}`;

export const startButton = (groupId: string, label = '📊 Buatkan laporan Google Sheets'): Action => ({ id: SHEET_LINK_IDS.start(groupId), label, kind: 'primary' });

/** Langkah login yang ditampilkan HANYA ke yang menekan tombol (kode ini jangan dibagikan). */
export function linkSteps(userCode: string, verificationUrl: string, minutes: number): string {
  return (
    `Oke! Tiga langkah aja 👇\n` +
    `1. Buka ${verificationUrl}\n` +
    `2. Masukkan kode **${userCode}**\n` +
    `3. Pilih akun Google kamu → **Izinkan**\n\n` +
    `Habis itu aku langsung bikin sheet-nya di Google Drive kamu dan kirim linknya lewat DM. ` +
    `Aku cuma bisa mengakses file yang aku buat sendiri, bukan isi Drive kamu yang lain.\n` +
    `⚠️ Jangan bagikan kode ini — kodenya berlaku ${minutes} menit.`
  );
}

/** Tombol "Buatkan laporan Google Sheets" ditekan. */
export async function handleSheetLinkAction(ev: ActionEvent, linker?: SheetLinker): Promise<Reply> {
  const [, , verb, groupId = ''] = ev.actionId.split(':');
  // Di server: tombol hanya berlaku untuk server itu sendiri. Di DM: kelas dari tombol, hak dicek lewat peran.
  if (!groupId || (ev.groupId && ev.groupId !== groupId)) return { reply: { text: 'Tombol ini bukan untuk kelas ini.', private: true } };
  const group = await getGroup(ev.platform, groupId);
  if (!group) return { reply: { text: NOT_SETUP_TEXT, private: true } };
  if (verb === 'later') return { update: { actions: [], text: 'Oke, nanti aja. Kapan pun bisa lewat `/kas sheet` 👍' } };
  // Sheet tinggal di Drive pribadi yang menekan → wajib peran kas eksplisit (bukan sekadar admin server),
  // supaya hak itu bisa dicek ulang setiap kali bot menulis (lihat ownerStillAllowed).
  if (!hasKasRole(group, ev.actor.platformUserId)) {
    return {
      reply: {
        text: ev.isAdmin
          ? 'Sheet-nya dibuat di Google Drive orang yang menekan, jadi harus bendahara / tim inti kas. Minta bendahara yang klik, atau tambahkan dirimu dulu: `/kas atur tambah_tim:@kamu`.'
          : 'Yang bisa bikin laporan kas cuma bendahara / tim inti kas ya 🙏',
        private: true,
      },
    };
  }
  if (!linker) return { reply: { text: 'Fitur ini belum diaktifkan operator bot (GOOGLE_OAUTH_CLIENT_ID). Sementara pakai `/kas ekspor`.', private: true } };
  if (group.kas?.sheetId) {
    // Tombol tawaran lama masih terpajang → hilangkan, supaya tidak ada yang mengira sheet belum dibuat.
    return {
      update: { actions: [], text: '📊 Laporan kas Google Sheets sudah dibuat. Linknya: `/kas sheet` (pengurus kas).' },
      reply: { text: `Laporan kas sudah ada: ${sheetUrl(group.kas.sheetId)}\nMau ganti? \`/kas sheet link:putus\` dulu.`, private: true },
    };
  }
  let s;
  try {
    s = await linker.start();
  } catch (err) {
    console.warn('[sheets] gagal minta kode login:', (err as Error).message);
    return { reply: { text: 'Google lagi nggak bisa dihubungi 😢 Coba lagi sebentar ya.', private: true } };
  }
  const at = now();
  // Satu login aktif per kelas; tombol ditekan lagi → kode lama diganti.
  await SheetLinkModel.findOneAndUpdate(
    { platform: ev.platform, groupId },
    {
      $set: {
        actor: { platformUserId: ev.actor.platformUserId, displayName: ev.actor.displayName },
        channelId: ev.channelId,
        deviceCode: s.deviceCode,
        interval: s.interval,
        nextPollAt: new Date(at.getTime() + s.interval * 1000),
        expiresAt: new Date(at.getTime() + s.expiresIn * 1000),
      },
    },
    { upsert: true },
  );
  return { reply: { text: linkSteps(s.userCode, s.verificationUrl, Math.round(s.expiresIn / 60)), private: true } };
}

function dmTo(link: Pick<Link, 'platform' | 'groupId' | 'actor' | 'channelId'>, level: SpeechLevel, text: string): OutgoingMessage {
  const member: Member = { platform: link.platform as Platform, platformUserId: link.actor.platformUserId, groupId: link.groupId, displayName: link.actor.displayName };
  return { to: { kind: 'dm', member, fallbackChannelId: link.channelId, fallbackText: PRIVATE_FALLBACK[level](mention(member)) }, text };
}

/** Cek login yang menunggu (dipanggil tiap beberapa detik). Selesai → buat sheet & kirim link. */
export async function pollSheetLinks(at: Date, linker: SheetLinker): Promise<OutgoingMessage[]> {
  const due = await SheetLinkModel.find({ nextPollAt: { $lte: at } }).limit(20).lean<Link[]>();
  const out: OutgoingMessage[] = [];
  for (const l of due) {
    // Klaim dulu (geser jadwal) supaya dua proses tidak memproses login yang sama.
    const claimed = await SheetLinkModel.findOneAndUpdate({ _id: l._id, nextPollAt: l.nextPollAt }, { $set: { nextPollAt: new Date(at.getTime() + l.interval * 1000) } });
    if (!claimed) continue;
    const group = await getGroup(l.platform as Platform, l.groupId);
    const level = (group?.speechLevel ?? 'santai') as SpeechLevel;
    if (!group || at > l.expiresAt) {
      await SheetLinkModel.deleteOne({ _id: l._id });
      if (group) out.push(dmTo(l, level, 'Kode login Google tadi sudah kedaluwarsa ⌛ Kalau masih mau, ketik `/kas sheet` lalu klik tombolnya lagi ya.'));
      continue;
    }
    const r = await linker.poll(l.deviceCode).catch((err: Error) => ({ status: 'error' as const, message: err.message }));
    if (r.status === 'pending') continue;
    if (r.status === 'slow_down') {
      await SheetLinkModel.updateOne({ _id: l._id }, { $inc: { interval: 5 } });
      continue;
    }
    await SheetLinkModel.deleteOne({ _id: l._id });
    if (r.status === 'denied') {
      out.push(dmTo(l, level, 'Oke, izin Google dibatalkan — aku nggak bikin apa-apa 👍'));
      continue;
    }
    if (r.status === 'expired') {
      out.push(dmTo(l, level, 'Kode login Google tadi sudah kedaluwarsa ⌛ Ketik `/kas sheet` lalu klik tombolnya lagi ya.'));
      continue;
    }
    if (r.status === 'error') {
      console.warn(`[sheets] login Google gagal (${group.className}): ${r.message}`);
      out.push(dmTo(l, level, 'Waduh, login Google-nya gagal 😢 Coba lagi lewat `/kas sheet` ya.'));
      continue;
    }
    if (!('credential' in r)) continue;
    out.push(...(await finishLink(group, l, r.credential, linker, level)));
  }
  return out;
}

async function finishLink(group: GroupDoc, l: Link, credential: string, linker: SheetLinker, level: SpeechLevel): Promise<OutgoingMessage[]> {
  let sheet;
  try {
    sheet = await linker.createSheet(credential, `Kas ${group.className} (MIC-Bot)`.slice(0, 100), KAS_TABS);
  } catch (err) {
    console.warn(`[sheets] gagal membuat sheet (${group.className}): ${(err as Error).message}`);
    await linker.revoke(credential);
    return [dmTo(l, level, 'Login Google berhasil, tapi aku gagal bikin sheet-nya 😢 Coba lagi lewat `/kas sheet` ya.')];
  }
  const previous = group.kas?.sheetAuth;
  await GroupModel.updateOne(
    { _id: group._id },
    {
      $set: {
        'kas.sheetId': sheet.id,
        'kas.sheetTitle': sheet.title.slice(0, 100),
        'kas.sheetAuth': credential,
        'kas.sheetOwnerId': l.actor.platformUserId,
        'kas.sheetDirtyAt': now(),
        'kas.sheetSyncedAt': null,
        'kas.sheetError': null,
        'kas.sheetOfferedAt': group.kas?.sheetOfferedAt ?? now(),
      },
    },
  );
  if (previous && previous !== credential) await linker.revoke(previous);
  await audit(group.groupId, l.actor, 'kas.sheet', `dibuat otomatis: ${sheet.title.slice(0, 80)}`);
  const text =
    `✅ Laporan kas **${sanitize(sheet.title)}** sudah jadi di Google Drive kamu:\n${sheetUrl(sheet.id)}\n\n` +
    `Dalam ±1 menit aku isi tab ${KAS_TABS.join(', ')} — setelah itu diperbarui otomatis tiap ada perubahan kas.\n\n` +
    `🔒 Sekarang cuma kamu yang bisa membukanya. Mau berbagi ke tim inti/wali kelas? Klik **Share/Bagikan** → masukkan email mereka. ` +
    `Biarkan Akses umum tetap **Dibatasi** — kalau dibuka untuk siapa saja yang punya link, aku berhenti mengisinya (isinya nama & status bayar teman-teman).`;
  const msgs = [dmTo(l, level, text)];
  // Tim inti cukup tahu laporannya sudah ada (tanpa link — yang berbagi akses si pemilik sheet).
  if (group.kas?.reviewChannelId && group.kas.reviewChannelId !== l.channelId) {
    msgs.push({ to: { kind: 'channel', channelId: group.kas.reviewChannelId }, text: `📊 Laporan kas Google Sheets sudah dibuat oleh ${mention(l.actor)}. Minta aksesnya ke dia ya.` });
  }
  return msgs;
}

/**
 * Tawarkan sekali ke kelas yang punya kas tapi belum punya laporan Sheets: di channel tim inti kalau ada,
 * selain itu DM bendahara. Tidak di jam tenang / mode jeda.
 */
export async function collectSheetOffers(at: Date): Promise<OutgoingMessage[]> {
  const groups = await GroupModel.find({
    'kas.amount': { $gt: 0 },
    'kas.sheetId': null,
    'kas.sheetOfferedAt': null,
    // Kelas yang mengatur kas sebelum kolom setAt ada (kosong) juga ditawari.
    'kas.setAt': { $not: { $gt: new Date(at.getTime() - OFFER_AFTER_MS) } },
    pilotMode: { $ne: 'jeda' },
  })
    .limit(50)
    .lean<GroupDoc[]>();
  const out: OutgoingMessage[] = [];
  for (const g of groups) {
    if (inQuietHours(at, g.quietHours)) continue;
    const k = g.kas!;
    if (!k.reviewChannelId && !k.treasurerId) continue; // belum ada yang bisa ditawari
    const claimed = await GroupModel.findOneAndUpdate({ _id: g._id, 'kas.sheetOfferedAt': null }, { $set: { 'kas.sheetOfferedAt': at } });
    if (!claimed) continue;
    const text =
      `📊 Mau laporan kas ${g.className} otomatis di **Google Sheets**? Buku kas, status iuran, dan bukti transfer langsung rapi buat LPJ — ` +
      `aku yang bikin sheet-nya dan memperbaruinya sendiri. Cukup klik tombol di bawah, login Google, selesai.`;
    const actions: Action[] = [startButton(g.groupId), { id: SHEET_LINK_IDS.later(g.groupId), label: 'Nanti aja', kind: 'secondary' }];
    if (k.reviewChannelId) {
      out.push({ to: { kind: 'channel', channelId: k.reviewChannelId }, text, actions });
    } else {
      const member: Member = { platform: g.platform as Platform, platformUserId: k.treasurerId!, groupId: g.groupId, displayName: 'Bendahara' };
      // Tombol di DM tetap dicek hak aksesnya saat ditekan.
      out.push({ to: { kind: 'dm', member, fallbackChannelId: g.kasChannelId ?? g.mainChannelId, fallbackText: PRIVATE_FALLBACK[g.speechLevel as SpeechLevel](mention(member)) }, text, actions });
    }
  }
  return out;
}

/** Peran kas eksplisit (bendahara / tim inti kas) — status admin server sengaja tidak dihitung. */
const hasKasRole = (g: GroupDoc, userId: string) => can(g, { isAdmin: false, actor: { platformUserId: userId } }, 'kas');

/** Pemilik sheet buatan bot masih pengurus kas? Dicek live dari peran saat ini (sheet manual selalu boleh). */
export function ownerStillAllowed(g: GroupDoc): boolean {
  const k = g.kas;
  if (!k?.sheetAuth || !k.sheetOwnerId) return true;
  return hasKasRole(g, k.sheetOwnerId);
}
