# PLAN — MVP Discord (< 2 minggu)

Target: demo end-to-end 4 fitur + data pilot dari 1–2 kelas untuk juri.
Urutan = prioritas. Kalau waktu mepet, potong dari bawah.

## M0 — Kerangka (Hari 1–2)
- [x] Init Bun + TS strict, eslint, docker-compose (bot + mongo)
- [x] `config.ts` validasi env pakai zod
- [x] `core/types.ts`: IncomingMessage, OutgoingMessage, Action
- [x] Adapter Discord: messageCreate → core, render OutgoingMessage (teks, embed, button), interactionCreate → Action
- [x] `llm/openrouter.ts` dengan `chat()` dan `vision()`, output JSON tervalidasi
- [x] `/setup` : simpan Group (nama kelas, jurusan, tingkat tutur, channel kas & info lomba)
- [x] `/ping`
**Demo:** bot online, `/setup` tersimpan di DB.

## M1 — Janji + Tagihan (Hari 3–5) ★ inti
- [x] Prefilter kata kunci → LLM ekstraksi `{ isPromise, task, owner, deadline }`
- [x] Parser tanggal relatif Asia/Jakarta (test: "Jumat", "besok sore", "tgl 30", "minggu depan")
- [x] Balasan konfirmasi dengan tombol ✅ / ✏️ / ❌ (✏️ buka modal ubah tugas/deadline)
- [x] Skema Promise: status `pending_confirm | active | done | overdue | cancelled`
- [x] Scheduler polling 60 dtk: H-2, H-1, H-0, +1 (eskalasi ke grup)
- [x] Template tagihan per tingkat tutur (santai/sopan/krama) — variasi kalimat agar tidak monoton
- [x] Tombol "✅ Sudah selesai" di pesan pengingat; `/janji list`, `/janji selesai`
- [x] Skor ketepatan janji per kelas (`/rapor-kelas`) — pola leaderboard dari ctf-assistant
**Demo:** ketik "aku yang bikin PPT ya, Jumat jadi" → konfirmasi → (waktu dipercepat lewat env `DEMO_TIME_SCALE`) → tagihan bertahap.

## M2 — Kas kelas (Hari 6–7)
- [x] `/kas atur` : nominal iuran & periode (mingguan/bulanan)
- [x] Upload gambar di channel kas → LLM vision ekstraksi `{ nominal, tanggal, bank, pengirim, refId }`
- [x] Verifikasi realistis (jangan klaim forensik):
  - hash gambar duplikat (bukti dipakai dua kali)
  - refId/nomor transaksi duplikat
  - nominal/tanggal tidak cocok dengan iuran/periode
  - bendahara bisa approve/tolak lewat tombol
- [x] Ledger Transaction (append-only, koreksi = transaksi baru)
- [x] `/kas rekap` : siapa sudah/belum bayar; tagihan kas ikut scheduler dengan nada unggah-ungguh
- [x] Ekspor CSV ledger (bahan LPJ)
**Demo:** kirim foto bukti transfer → tercatat → rekap → pengingat sopan untuk yang belum.

## M3 — Rangkuman (Hari 8)
- [x] Buffer pesan di Mongo dengan TTL 48 jam
- [x] `/rangkum [jam]` → ringkasan: keputusan, tugas baru, info penting
- [ ] (opsional) rangkuman otomatis harian kalau obrolan > N pesan
**Demo:** obrolan 50 pesan → `/rangkum 3`.

## M4 — Info lomba (Hari 9)
Versi demo: kurasi, bukan scraper.
- [x] Koleksi Opportunity: judul, penyelenggara, deadline, jurusan/tag, link, `sponsored`
- [x] `/lomba tambah` (admin) + seed 15–20 info lomba nyata
- [x] Saring relevansi per Group (jurusan/tag) → posting ke #info-lomba, maks 2/minggu
- [x] Label "Promosi" jika sponsored
- [x] Tombol "Bentuk tim" → bikin thread + janji awal
**Demo:** info lomba yang cocok jurusan muncul, klik "Bentuk tim".

## M5 — Siap demo (Hari 10–11)
- [ ] Error handling & log; LLM gagal ≠ bot crash
- [ ] Hitung biaya LLM per 100 pesan (angka untuk slide model bisnis)
- [ ] Skrip demo + server Discord demo yang rapi
- [ ] README + diagram arsitektur (core/adapter → janji WA tinggal ganti adapter)

## M6 — Pilot & validasi (Hari 12–13, sebagian bisa paralel sejak Hari 6)
- [ ] Pasang di 1–2 kelas/tim lomba; catat: janji tercatat, janji ditepati, kas tercatat
- [ ] Survei singkat + wawancara ketua/bendahara (lihat Rencana validasi di konsep)

## Setelah lomba
- Adapter WhatsApp (Baileys) dengan nomor dummy
- Scraper info lomba, sinkron Google Calendar/Notion
