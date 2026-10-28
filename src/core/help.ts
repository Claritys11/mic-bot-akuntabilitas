import { channelRef } from './types.ts';

// Panduan singkat: yang utama "cukup ngobrol"; perintah hanya cadangan. Bagian pengurus hanya untuk admin.

export interface HelpContext {
  isAdmin: boolean;
  kasChannelId?: string | null;
  /** WhatsApp: perintah teks diketik; Discord: slash command dari menu. */
  textCommands?: boolean;
}

export const HELP_WORDS = /\b(bantuan|help|tolong jelasin|bisa apa(?: aja| saja)?|cara pakai|cara pake|fitur(?:nya)?|panduan)\b/i;

export function helpText(ctx: HelpContext): string {
  const kas = ctx.kasChannelId ? `di ${channelRef(ctx.kasChannelId)}` : 'di grup (kasih keterangan *kas*)';
  const lines = [
    '**Halo! Aku MIC-Bot 👋 Cukup ngobrol biasa aja:**',
    '• **Janji** — _"aku yang bikin PPT, jumat"_ → aku catat & ingetin sebelum deadline. Salah tangkap? balas _"bukan"_.',
    '• **Tanya** — _"ada tugas gak?"_, _"kas aku udah lunas?"_, _"ada lomba ga?"_',
    '• **Pengingat** — _"@MIC ingetin aku besok jam 7 bawa proyektor"_ (atau _"ingetin kita senin …"_ buat sekelas). Tanpa tag pun, _"jangan lupa besok …"_ / _"takut lupa …"_ → aku tawarin ngingetin. Mau ikut diingetin juga? klik **🙋 Ingetin aku juga**.',
    `• **Bayar kas** — kirim foto bukti transfer ${kas}, bendahara yang ngecek.`,
    '• **Info lomba** — kirim link lombanya sambil tag aku, nanti aku bacakan.',
    '',
    `**Perintah cadangan:** /janji list · /kas rekap · /lomba list · /ingetin · /rangkum · /data hapus-saya`,
  ];
  if (ctx.isAdmin) {
    lines.push(
      '',
      '**Khusus pengurus:**',
      '• /setup — atur ulang kelas (tanpa opsi = diwawancarai)',
      '• /kas atur — iuran, bendahara, `cek_bukti` (DM / channel tim inti 🔒), `tambah_tim`, `penerima` rekening',
      '• /lomba tambah link:… — cukup link, aku baca sendiri',
      '• /pilot mode diam|aktif|jeda — uji coba & rem darurat',
      '• /jam-tenang — default 21.00–06.00: pengingat ditahan malam hari',
      '• /kas sheet — laporan kas otomatis di Google Sheets (bot yang bikinin, cukup login Google); /kas keluar · /kas masuk',
    );
  }
  if (ctx.textCommands) lines.push('', '_Di WhatsApp, perintah diketik, mis. `/janji list`._');
  return lines.join('\n');
}
