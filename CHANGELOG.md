# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/). Versi mengikuti milestone di `PLAN.md`.

## [Belum dirilis]

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
