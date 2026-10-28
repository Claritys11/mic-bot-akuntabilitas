# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/). Versi mengikuti milestone di `PLAN.md`.

## [Belum dirilis]

### Ditambahkan
- Tampilan laporan Google Sheets: Rupiah (format angka Indonesia, tetap bisa dijumlah), header berwarna, baris belang, filter, warna status (Lunas/Disetujui hijau, Menunggu kuning, Kurang/Ditolak merah), lebar kolom tetap + teks panjang dibungkus, Ringkasan bergaya dasbor dengan panduan "Cara pakai", peringatan Google saat tab buatan bot diedit.
- Bot menawarkan diri mengingatkan tanpa perlu di-tag: obrolan seperti _"jangan lupa besok …"_, _"takut lupa …"_, _"ingetin aku ya besok …"_ (ada waktunya) → tombol **⏰ Iya, ingetin / Nggak usah**; aktif hanya setelah diiyakan penulisnya (pengingat kelas boleh juga oleh admin). Maks. satu tawaran per kelas tiap 5 menit.
- Indikator "sedang mengetik…" sebelum setiap balasan (Discord & WhatsApp); saat di-tag, tampil selama bot berpikir.
- Bot yang memulai laporan kas Google Sheets: tawaran sekali ke tim inti/bendahara → tombol → login Google lewat kode (`google.com/device`) → sheet dibuat di Drive bendahara (scope `drive.file`), link via DM. Token tersegel AES-256-GCM, dicabut saat `/kas sheet link:putus`; berhenti menulis kalau pemilik bukan pengurus kas lagi.
- Laporan kas otomatis di Google Sheets (`/kas sheet`), pencatatan pengeluaran & pemasukan lain (`/kas keluar`, `/kas masuk`).
- Bendahara bisa orang (DM) atau channel `#tim-inti` (dicari, dibuatkan privat kalau belum ada); tim inti eksplisit (`tambah_tim`/`hapus_tim`).
- Bot menindaklanjuti: pengingat pribadi/kelas (`@MIC ingetin …`, `/ingetin`), tanya ulang janji yang belum dijawab, tanya kabar sehari setelah lewat deadline, rangkuman Senin pagi.
- Data lomba otomatis: baca link (`@MIC ada lomba nih …`, `/lomba tambah link:`) → draf untuk pengurus; feed RSS harian; ambil halaman aman SSRF.
- `/bantuan` di Discord & WhatsApp, "@MIC bisa apa aja?".
- Janji jelas (LLM yakin, pemilik sendiri, ada deadline) langsung aktif; salah tangkap → balas "bukan" / tombol "Bukan janjiku"; yang belum diakui tidak pernah diumumkan ke grup.
- Rem darurat `/pilot mode jeda` dan penghapusan data `/data hapus-saya|hapus-anggota|hapus-kelas`.
- Mode diam untuk baseline pilot + `/pilot ekspor` dengan kolom cek ketua.
- Alat holdout (`bun run holdout`), log biaya LLM nyata, catatan bot mati + DM operator, `scripts/backup.sh`.
- `docs/DEMO.md` + `bun run demo:check`.
- Rencana pilot (`docs/PILOT.md`) dan `bun run pilot:metrics` (ketepatan janji, telat, salah-aktif, kas).
- Cek rekening penerima bukti kas (`/kas atur penerima:...`) dan perceptual hash untuk bukti yang di-screenshot ulang.
- Mode tanpa simpan bukti: detail pribadi bukti kas dihapus setelah ditinjau; OpenRouter `data_collection=deny`.
- Adapter WhatsApp eksperimental (Baileys), nonaktif default: balas angka, form balasan, perintah teks, bukti kas lewat chat pribadi ke bendahara.
- Discord & WhatsApp bisa jalan bersamaan; pesan terjadwal dirutekan per platform.

### Diubah
- Deteksi janji mengenali slang & Jawa (sy yg, tak garapne, ku kerjain) dan menolak cerita lampau.
- Prioritas: pilot (M6) sebelum Fase 2; Fase 2 dibekukan sampai ada data.

### Diperbaiki
- Uji dengan Google sungguhan: kode locale `id_ID` ditolak Sheets API → coba `in_ID`/`id_ID`, lalu bawaan akun.
- Kelas yang mengatur kas sebelum fitur Sheets ada tidak pernah ditawari laporan (kolom `setAt` kosong).

### Direncanakan
- Fase 2 — pengaturan ramah pengguna: panel `/pengaturan`, peran pengurus, kas lengkap (tunai,
  pengeluaran, patungan, riwayat tarif), tambah lomba dari link/poster, jam tenang, pengaturan lewat
  obrolan. Lihat `PLAN.md` M7–M11.

## [0.2.0] — 2026-10-23 · Bot terasa seperti teman sekelas

### Ditambahkan
- Bot nimbrung saat mendeteksi janji ("jadi gak @kamu? kalau jadi langsung ku catat nih") dengan kalimat LLM + template cadangan.
- Deteksi suasana obrolan (santai/serius/tegang/sedih); tidak tertawa saat suasana serius.
- Menjawab "ada tugas gak nih?", status kas penanya, info lomba — tanpa perlu di-tag; termasuk bahasa Jawa.
- Konfirmasi janji lewat ketikan ("jadi dong, besok" / "ga jadi").
- Wawancara setup santai lewat obrolan; bot bisa membuat channel; kelas multi-jurusan.
- `bun run eval:voice` untuk menguji suara bot ke LLM sungguhan.
- Key & rantai model cadangan OpenRouter dengan cooldown; `LLM_PROVIDER_SORT`.

### Diubah
- Model default `z-ai/glm-5.3-flash` (teks + gambar).

### Keamanan
- Undangan bot memakai izin minimal + Manage Channels, bukan Administrator.

## [0.1.0] — 2026-10-22 · Prototipe M0–M4

### Ditambahkan
- Kerangka Bun + TypeScript, adapter Discord, core netral platform, MongoDB, docker compose.
- Deteksi janji + konfirmasi tombol, tagihan bertahap H-2/H-1/H-0/lewat dengan unggah-ungguh, `/rapor-kelas`.
- Kas: baca bukti transfer (vision), verifikasi duplikat/nominal/tanggal, ledger append-only, rekap, ekspor CSV.
- `/rangkum` dengan buffer pesan TTL 48 jam.
- Info lomba relevan per jurusan, tombol "Bentuk tim".

### Keamanan
- Info lomba dicakup per server, konfirmasi janji hanya pemilik, netralisasi token mention.
