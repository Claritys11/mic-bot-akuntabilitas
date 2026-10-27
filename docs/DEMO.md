# Skrip Demo (± 5 menit)

Juri menilai dari apa yang mereka **lihat bergerak**. Satu alur utuh, bukan daftar fitur.

## Persiapan (H-1 dan 30 menit sebelum tampil)

1. Server Discord demo khusus (bukan server pilot). Bot sudah diundang dan setup selesai
   (kelas, gaya bahasa **santai**, channel `#kas-kelas`, iuran Rp10.000/bulan, bendahara = akun kedua).
2. `.env`: `DEMO_TIME_SCALE=1440` (1 menit nyata = 1 hari virtual), lalu restart bot.
3. `/kas atur 10000 bulanan penerima:"Nama Rekening Kas"`.
4. `bun run demo:check` → harus "Siap demo 🚀".
5. Dua akun Discord terbuka: **Ani** (siswa) dan **Sari** (bendahara). Siapkan 2 screenshot bukti
   transfer: satu benar, satu ke rekening lain.
6. **Rekam video demo lengkap sebagai cadangan** (Wi-Fi/API bisa bermasalah saat presentasi).

## Alur

| Waktu | Lakukan | Yang terlihat | Kalimat ke juri |
|---|---|---|---|
| 0:00 | Ani ketik: *"aku yang bikin PPT ya, jumat jadi"* | Bot langsung: "siap @Ani, udah ku catat… salah tangkap? balas 'bukan'" | "Tidak ada form, tidak ada perintah. Cukup ngobrol seperti biasa." |
| 0:40 | Ketik *"ada tugas gak nih?"* | Bot menjawab daftar janji dari catatan | "Bot ikut nimbrung dan hanya menjawab dari data, tidak mengarang." |
| 1:10 | Tunggu ±1–2 menit (waktu dipercepat) | DM ke Ani: pengingat H-2 → H-0, nadanya makin tegas tapi sopan | "*Ewuh pakewuh*: tidak ada yang mau menagih teman. Bot yang menagih, secara pribadi dulu." |
| 2:10 | Biarkan lewat deadline | Pengumuman ke grup bernada mengajak membantu, bukan mempermalukan | "Baru diumumkan setelah lewat — dan hanya janji yang diakui pemiliknya." |
| 2:40 | Ani klik ✅ Sudah selesai | "akhirnya kelar juga…" + kabar baik ke grup | |
| 3:00 | Ani kirim bukti transfer benar di `#kas-kelas` | Kartu bukti: nominal, tanggal, penerima terbaca → Sari klik ✅ Setujui | "Uang tidak pernah dipegang bot. Bot mencatat dan memeriksa." |
| 3:40 | Ani kirim bukti ke rekening lain / screenshot ulang | ⚠️ "Penerima bukan rekening kas" / "Gambar sangat mirip bukti sebelumnya" | "Celah yang biasa dipakai, ditandai otomatis untuk bendahara." |
| 4:10 | `/kas rekap` dan `/rapor-kelas` | Rekap tanpa mempermalukan; skor di level kelas | "Tidak ada skor individu, tidak ada dasbor guru." |
| 4:40 | Tutup dengan angka pilot | Slide hasil `bun run pilot:metrics` (baseline vs aktif + n) | "Ini hasil awal dari kelas pilot, bukan klaim." |

## Kalau ada yang macet

| Masalah | Tindakan |
|---|---|
| LLM lambat/gagal | Bot otomatis jatuh ke heuristik & template — tetap jalan. Sebutkan: "Kalau AI-nya mati, bot tetap bekerja." |
| Bot tidak membalas | `/ping` (cek status LLM & waktu demo). Pastikan kelas tidak dalam `/pilot mode diam`. |
| Pengingat belum muncul | Waktu dipercepat butuh ±1 menit per hari virtual; lanjut ke bagian kas dulu. |
| Internet mati | Putar video cadangan. |

## Pertanyaan juri yang perlu jawaban jujur

- **"Kenapa bukan WhatsApp?"** — API resmi WhatsApp untuk grup dibatasi dan tidak bisa masuk grup kelas
  yang sudah ada; jalur tidak resmi (Baileys) berisiko nomor diblokir. Core bot netral platform, adapter
  WhatsApp sudah ada untuk uji coba, tapi platform utama saat ini Discord.
- **"Data anak?"** — pesan mentah terhapus ≤ 48 jam, detail bukti kas dihapus setelah ditinjau, provider AI
  dibatasi yang tidak menyimpan data, ada formulir persetujuan wali untuk pilot.
- **"Berapa biayanya?"** — LLM ±Rp beberapa ribu per kelas per bulan; biaya utama adalah platform, bukan AI.
