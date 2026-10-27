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
7. Tambahkan satu lomba berbayar untuk momen model bisnis:
   `/lomba tambah judul:"Lomba Web Kampus X" deadline:2026-12-01 link:https://... tag:rpl,web promosi:ya`.
8. Siapkan tab terminal/Compass dengan `db.kasproofs.find().sort({_id:-1}).limit(1)` untuk momen privasi.
9. **Cek batas waktu pitching di rubrik MIC.** Kalau total hanya 5–7 menit, pakai versi 2 menit di bawah.

## Alur (versi lengkap ± 5 menit)

| Waktu | Lakukan | Yang terlihat | Kalimat ke juri |
|---|---|---|---|
| −0:30 | Slide: potongan obrolan kelas yang berantakan + satu angka survei Moklet | "x dari y bendahara sungkan menagih kas" | "Masalahnya bukan lupa — tidak ada yang mau jadi orang rewel. *Ewuh pakewuh*." |
| 0:00 | Ani ketik: *"aku yang bikin PPT ya, jumat jadi"* | Bot langsung: "siap @Ani, udah ku catat… salah tangkap? balas 'bukan'" | "Tidak ada form, tidak ada perintah. Cukup ngobrol seperti biasa." |
| 0:40 | Ketik *"ada tugas gak nih?"* | Bot menjawab daftar janji dari catatan | "Bot ikut nimbrung dan hanya menjawab dari data, tidak mengarang." |
| 1:10 | Tunggu ±1–2 menit (waktu dipercepat) | DM ke Ani: pengingat H-2 → H-0, nadanya makin tegas tapi sopan | "*Ewuh pakewuh*: tidak ada yang mau menagih teman. Bot yang menagih, secara pribadi dulu." |
| 2:10 | Biarkan lewat deadline | Pengumuman ke grup bernada mengajak membantu, bukan mempermalukan | "Baru diumumkan setelah lewat — dan hanya janji yang diakui pemiliknya." |
| 2:40 | Ani klik ✅ Sudah selesai | "akhirnya kelar juga…" + kabar baik ke grup | |
| 2:50 | `/setup kelas:"XI International" tutur:krama`, lalu Ani ketik janji baru | Bot menjawab & menagih dalam **krama** ("Sendika @Ani, sampun kula cathet…") | "*Unggah-ungguh*: kelas memilih cara bot berbicara." |
| 3:00 | Ani kirim bukti transfer benar di `#kas-kelas` | Kartu bukti: nominal, tanggal, penerima terbaca → Sari klik ✅ Setujui | "Uang tidak pernah dipegang bot. Bot mencatat dan memeriksa." |
| 3:40 | Ani kirim bukti ke rekening lain / screenshot ulang | ⚠️ "Penerima bukan rekening kas" / "Gambar sangat mirip bukti sebelumnya" | "Celah yang biasa dipakai, ditandai otomatis untuk bendahara." |
| 4:00 | Tunjukkan dokumen bukti di database | Setelah disetujui hanya tersisa nominal, tanggal, hash — tanpa nama, bank, nomor ref | "Data anak: yang tidak perlu, tidak disimpan." |
| 4:10 | `/kas rekap` dan `/rapor-kelas` | Rekap tanpa mempermalukan; skor di level kelas | "Tidak ada skor individu, tidak ada dasbor guru." |
| 4:25 | `/lomba list` | Lomba relevan jurusan, satu berlabel **[Promosi]** | "Siswa gratis. Yang membayar penyelenggara lomba/kampus yang ingin menjangkau kelas yang tepat — selalu berlabel dan tetap lolos saringan relevansi." |
| 4:40 | Tutup dengan angka pilot | Slide hasil `bun run pilot:metrics` (baseline vs aktif + n) | "Ini hasil awal dari kelas pilot, bukan klaim." |

## Versi 2 menit

| Waktu | Lakukan | Kalimat |
|---|---|---|
| 0:00 | Slide masalah + angka survei | "Tidak ada yang mau menagih teman." |
| 0:20 | Ani ketik janji → bot langsung mencatat | "Cukup ngobrol." |
| 0:40 | Tampilkan DM pengingat (sudah terjadi, waktu dipercepat) lalu versi krama | "Bot yang menagih, dengan *unggah-ungguh*." |
| 1:10 | Bukti transfer ke rekening lain → ditandai | "Kas tercatat, celah umum ditandai, uang tidak dipegang bot." |
| 1:35 | `/lomba list` dengan [Promosi] + angka pilot | "Model bisnis dan hasil awal pilot." |

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
