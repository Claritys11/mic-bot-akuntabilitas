import type { SpeechLevel } from '../types.ts';
import type { Stage } from './escalation.ts';

// Template tagihan per tingkat tutur. Placeholder: {nama} {tugas} {deadline}.
// Tahap overdue dikirim ke grup: nadanya mengajak membantu, bukan mempermalukan.

type Bank = Record<SpeechLevel, Record<Stage, string[]>>;

export const TEMPLATES: Bank = {
  santai: {
    h2: [
      'Halo {nama}! Cuma ngingetin, {tugas} deadline-nya {deadline} ya. Masih santai kok, 2 hari lagi 😄',
      '{nama}, {tugas} jatuh tempo {deadline}. Kalau udah mulai, mantap! 👍',
      'Psst {nama}, jangan lupa {tugas} ya — {deadline}. Semangat!',
    ],
    h1: [
      '{nama}, besok udah {deadline} nih buat {tugas}. Aman? Kalau butuh bantuan bilang aja ya.',
      'Reminder dikit {nama}: {tugas} tinggal sehari lagi ({deadline}). Gas! 🔥',
      'Hai {nama}, {tugas} besok ya ({deadline}). Kalau ada kendala, kabarin grup aja.',
    ],
    h0: [
      '{nama}, hari ini deadline {tugas} ({deadline}). Ditunggu ya, makasih! 🙏',
      'Hari H nih {nama}! {tugas} ditunggu sampai {deadline}. Kalau udah, pencet tombol di bawah ya.',
      '{nama}, {tugas} jatuh tempo hari ini ({deadline}). Teman-teman nunggu, semangat!',
    ],
    overdue: [
      'Guys, {tugas} dari {nama} udah lewat deadline ({deadline}). Mungkin lagi ada kendala — ada yang bisa bantu?',
      'Update: {tugas} ({nama}) belum kelar dan sudah lewat {deadline}. Yuk dibantu bareng biar nggak molor.',
      '{tugas} yang dipegang {nama} lewat dari {deadline}. {nama}, kalau butuh tangan tambahan, bilang aja ya 🤝',
    ],
  },
  sopan: {
    h2: [
      'Halo {nama}, sekadar mengingatkan: {tugas} dijadwalkan selesai {deadline}. Terima kasih 🙏',
      'Selamat siang {nama}. Pengingat ringan, {tugas} jatuh tempo {deadline}. Semoga lancar ya.',
      'Mohon izin mengingatkan {nama}, {tugas} ditargetkan {deadline}. Terima kasih atas kerja samanya.',
    ],
    h1: [
      '{nama}, {tugas} tinggal satu hari lagi ({deadline}). Bila ada kendala, silakan kabari teman-teman ya.',
      'Mohon maaf mengganggu {nama}, {tugas} jatuh tempo besok ({deadline}). Terima kasih 🙏',
      'Pengingat untuk {nama}: {tugas} dijadwalkan besok, {deadline}. Semangat!',
    ],
    h0: [
      '{nama}, hari ini batas waktu {tugas} ({deadline}). Mohon diselesaikan ya, terima kasih.',
      'Mohon maaf {nama}, {tugas} jatuh tempo hari ini ({deadline}). Kami tunggu kabarnya 🙏',
      'Pengingat terakhir untuk {nama}: {tugas} perlu selesai hari ini ({deadline}). Terima kasih banyak.',
    ],
    overdue: [
      'Teman-teman, {tugas} yang dipegang {nama} sudah melewati batas waktu ({deadline}). Mungkin ada kendala — siapa yang bisa membantu?',
      'Informasi: {tugas} ({nama}) belum selesai dan sudah lewat {deadline}. Mari kita bantu bersama agar tidak tertunda.',
      'Mohon perhatian, {tugas} oleh {nama} melewati tenggat {deadline}. {nama}, silakan sampaikan bila perlu bantuan 🤝',
    ],
  },
  krama: {
    h2: [
      'Nuwun sewu {nama}, badhe ngengetaken: {tugas} kedah rampung {deadline}. Matur nuwun 🙏',
      'Sugeng {nama}, nyuwun pangapunten ngganggu. Namung ngengetaken bilih {tugas} dipunajeng-ajeng {deadline}.',
      'Nuwun sewu {nama}, {tugas} wekdalipun {deadline}. Mugi-mugi lancar nggih.',
    ],
    h1: [
      'Nuwun sewu {nama}, {tugas} kantun sedinten malih ({deadline}). Menawi wonten alangan, matur kemawon nggih.',
      'Nyuwun pangapunten {nama}, {tugas} wekdalipun benjang ({deadline}). Matur nuwun sanget 🙏',
      'Sugeng {nama}, ngengetaken malih bilih {tugas} benjang sampun wekdalipun ({deadline}).',
    ],
    h0: [
      'Nyuwun pangapunten {nama}, dinten menika wekdal pungkasanipun {tugas} ({deadline}). Kula nengga kabaripun nggih 🙏',
      'Nuwun sewu {nama}, {tugas} kedah rampung dinten menika ({deadline}). Matur nuwun sanget.',
      'Sugeng {nama}, dinten menika {tugas} sampun dumugi wekdalipun ({deadline}). Mugi lancar.',
    ],
    overdue: [
      'Para kanca, nyuwun pangapunten. {tugas} saking {nama} sampun langkung saking wekdal ({deadline}). Menawi wonten alangan, mangga dipunrembag sesarengan.',
      'Nuwun sewu, {tugas} ingkang dipuncepeng {nama} dereng rampung lan sampun langkung {deadline}. Sinten ingkang saged mbiyantu?',
      'Kanca-kanca, {tugas} ({nama}) sampun langkung wekdalipun ({deadline}). {nama}, menawi betah pitulungan, matur kemawon nggih 🤝',
    ],
  },
};

// Lewat deadline, tapi lewat chat pribadi (janji auto-aktif yang belum diakui pemiliknya).
export const OVERDUE_PRIVATE: Record<SpeechLevel, string[]> = {
  santai: [
    '{nama}, {tugas} udah lewat deadline ({deadline}). Udah kelar? Pencet tombol di bawah ya. Kalau ternyata itu bukan janjimu, pencet "Bukan janjiku" 🙏',
  ],
  sopan: [
    '{nama}, {tugas} sudah melewati batas waktu ({deadline}). Bila sudah selesai, silakan tekan tombol di bawah. Bila itu bukan janji Anda, tekan "Bukan janji saya" 🙏',
  ],
  krama: [
    'Nuwun sewu {nama}, {tugas} sampun langkung wekdalipun ({deadline}). Menawi sampun rampung, mangga pencet tombol ing ngandhap. Menawi sanes janji panjenengan, pencet "Sanes janji kula" 🙏',
  ],
};

export function overduePrivateText(level: SpeechLevel, vars: { nama: string; tugas: string; deadline: string }, seed: string): string {
  return fill(pick(OVERDUE_PRIVATE[level], seed), vars);
}

export type KasStage = 'mid' | 'end';

export const KAS_TEMPLATES: Record<SpeechLevel, Record<KasStage, string[]>> = {
  santai: {
    mid: [
      'Halo {nama}! Iuran kas {periode} ({nominal}) belum kecatat nih. Kalau udah transfer, kirim buktinya di channel kas ya 🙌',
      '{nama}, jangan lupa kas {periode} ya ({nominal}). Makasih udah gotong royong! 💪',
      'Hai {nama}, kas {periode} sebesar {nominal} masih ditunggu. Santai, masih ada waktu kok.',
    ],
    end: [
      '{nama}, periode kas {periode} hampir habis. Iuran {nominal} ditunggu ya, makasih! 🙏',
      'Reminder terakhir {nama}: kas {periode} ({nominal}). Kalau ada kendala, ngobrol aja sama bendahara.',
      '{nama}, kas {periode} ({nominal}) belum masuk. Kalau lagi seret, bilang ke bendahara aja ya, nggak apa-apa.',
    ],
  },
  sopan: {
    mid: [
      'Halo {nama}, sekadar mengingatkan iuran kas {periode} sebesar {nominal}. Bukti transfer bisa dikirim di channel kas. Terima kasih 🙏',
      'Mohon izin mengingatkan {nama}, kas {periode} ({nominal}) belum tercatat. Terima kasih atas gotong royongnya.',
      '{nama}, iuran kas {periode} ({nominal}) masih kami tunggu. Terima kasih.',
    ],
    end: [
      'Mohon maaf {nama}, periode kas {periode} segera berakhir. Iuran {nominal} mohon dilengkapi ya. Terima kasih.',
      '{nama}, pengingat terakhir kas {periode} ({nominal}). Bila ada kendala, silakan hubungi bendahara.',
      'Mohon perhatian {nama}, kas {periode} sebesar {nominal} belum tercatat. Terima kasih atas pengertiannya 🙏',
    ],
  },
  krama: {
    mid: [
      'Nuwun sewu {nama}, ngengetaken iuran kas {periode} {nominal}. Bukti transfer saged dipunkintunaken wonten channel kas. Matur nuwun 🙏',
      'Sugeng {nama}, kas {periode} ({nominal}) dereng kacathet. Matur nuwun gotong royongipun.',
      'Nyuwun pangapunten {nama}, iuran kas {periode} ({nominal}) taksih dipunantos.',
    ],
    end: [
      'Nuwun sewu {nama}, wekdal kas {periode} badhe telas. Iuran {nominal} mugi saged dipunjangkepi. Matur nuwun.',
      'Nyuwun pangapunten {nama}, menika pangeling pungkasan kas {periode} ({nominal}). Menawi wonten alangan, mangga matur bendahara.',
      'Sugeng {nama}, kas {periode} {nominal} dereng mlebet. Matur nuwun pangertosanipun 🙏',
    ],
  },
};

/** Hash FNV-1a kecil untuk memilih variasi secara deterministik. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function pick<T>(items: T[], seed: string): T {
  return items[hash(seed) % items.length]!;
}

export function billingText(
  level: SpeechLevel,
  stage: Stage,
  vars: { nama: string; tugas: string; deadline: string },
  seed: string,
): string {
  return fill(pick(TEMPLATES[level][stage], seed), vars);
}

export function kasText(
  level: SpeechLevel,
  stage: KasStage,
  vars: { nama: string; periode: string; nominal: string },
  seed: string,
): string {
  return fill(pick(KAS_TEMPLATES[level][stage], seed), vars);
}
