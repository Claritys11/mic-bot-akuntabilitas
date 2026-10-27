# PLAN

# Fase 1 — MVP Discord (< 2 minggu)

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

## Tambahan di luar rencana awal (sudah jadi)
- [x] Wawancara setup lewat obrolan, bot bisa bikin channel, kelas multi-jurusan
- [x] Bot nimbrung seperti teman sekelas saat mendeteksi janji (kalimat LLM + template cadangan)
- [x] Membaca suasana obrolan (santai/serius/tegang/sedih); tanpa tawa saat serius
- [x] Menjawab "ada tugas gak nih?", status kas penanya, info lomba — tanpa perlu di-tag
- [x] Konfirmasi janji lewat ketikan ("jadi dong, besok" / "ga jadi")
- [x] `bun run eval:voice` — uji suara bot ke LLM sungguhan

---

# Fase 2 — Gampang diatur (pengaturan ramah pengguna)

Masalah sekarang: pengaturan tersebar di `/setup`, `/kas atur`, `/lomba tambah` (7 opsi diketik
manual), hanya admin server yang bisa mengatur, dan tidak ada satu tempat untuk *melihat* semua
pengaturan. Ketua/bendahara kelas bukan orang teknis — mereka harus bisa mengatur bot tanpa
membaca dokumentasi.

**Target terukur**
- Pengurus baru bisa mengaktifkan kas dari nol dalam **< 2 menit** tanpa slash command.
- Menambah info lomba = **tempel link / kirim poster**, bukan isi 7 kolom.
- Setiap pengaturan bisa dilihat dalam **satu pesan** dan diubah dengan **≤ 3 klik**.
- Setiap perubahan bisa **dibatalkan** dan tercatat siapa yang mengubah.

## Prinsip desain pengaturan (berlaku untuk M7–M11)

1. **Tiga pintu, satu sumber.** Pengaturan bisa diubah lewat (a) obrolan biasa
   ("@MIC iuran kas jadi 5rb seminggu"), (b) panel `/pengaturan` (tombol + form),
   (c) slash command cepat. Ketiganya memanggil **satu** `core/settings/service.ts`
   (validasi zod, cek izin, catat riwayat). Tidak ada jalur yang menulis `GroupModel` langsung.
2. **Default yang masuk akal.** Bot langsung berguna tanpa diatur; pengaturan hanya untuk
   menyesuaikan. Skema dibaca lewat `SettingsSchema.parse(doc.settings ?? {})` sehingga grup lama
   otomatis dapat nilai default — **tanpa migrasi**.
3. **Pratinjau → konfirmasi → bisa dibatalkan.** Perubahan penting (nominal kas, bendahara,
   frekuensi lomba) tampil sebagai kartu "sebelum → sesudah" dengan tombol ✅ Simpan / ❌ Batal,
   dan tombol ↩️ Urungkan selama 10 menit setelah disimpan.
4. **Hanya tombol + form.** Tidak pakai select menu/komponen khusus Discord, supaya panel yang sama
   nanti jalan di WhatsApp sebagai "balas 1/2/3" (aturan arsitektur: core tidak tahu platform).
5. **Bahasa ikut tingkat tutur** grup, termasuk label tombol panel.
6. **Peran, bukan izin Discord.** Ketua kelas belum tentu admin server → ada peran pengurus di DB.

## Peran & izin (dipakai semua milestone)

| Aksi | Admin server | Ketua | Bendahara | Sekretaris | Anggota |
|---|:-:|:-:|:-:|:-:|:-:|
| Ubah profil kelas, peran, fitur on/off | ✅ | ✅ | – | – | – |
| Atur kas, catat tunai/pengeluaran, approve bukti | ✅ | – | ✅ | – | – |
| Tambah/kelola lomba, atur posting lomba | ✅ | ✅ | – | ✅ | usul* |
| Atur pengingat janji & rangkuman | ✅ | ✅ | – | ✅ | – |
| Lihat pengaturan (tanpa data sensitif) | ✅ | ✅ | ✅ | ✅ | ✅ |

\* Usulan anggota masuk antrian, tampil setelah disetujui pengurus (cegah spam/promosi liar).

---

## M7 — Fondasi pengaturan ★ wajib duluan (2–3 hari)

Semua milestone berikutnya menempel di sini.

- [ ] `core/settings/schema.ts`: `SettingsSchema` (zod) dengan default per bagian:
      `profil`, `peran`, `kas`, `lomba`, `janji`, `obrolan`, `jamTenang`
- [ ] `core/settings/service.ts`: `getSettings(groupId)`, `previewPatch(groupId, patch)` → diff,
      `applyPatch(ctx, patch, via)` (cek izin per bagian, validasi, simpan atomik), `undo(changeId)`
- [ ] Koleksi `SettingChange { groupId, actor, section, before, after, via: chat|panel|command, at }`
      dengan TTL 180 hari (cukup untuk audit 1 semester; data pribadi tidak disimpan di sini)
- [ ] Peran pengurus di `Group.roles { ketua[], bendahara[], sekretaris[] }`; migrasi otomatis
      `kas.treasurerId` → `roles.bendahara`. Helper `can(ctx, 'kas.atur')` menggantikan `isAdmin`
      yang tersebar di kas/lomba/janji/onboarding
- [ ] `/pengaturan` → satu kartu ringkasan + tombol per bagian (lihat mockup di bawah).
      Tombol bagian membuka sub-panel; isian bebas pakai Form (modal)
- [ ] `/bantuan` → contoh kalimat yang bisa diketik ke bot, sesuai peran si penanya
- [ ] Wawancara `/setup` yang sudah ada menulis lewat `applyPatch` (bukan langsung ke model)
- [ ] Test: default terisi untuk grup lama, izin per peran, diff, undo, patch tidak valid ditolak

```
⚙️ Pengaturan — XI International
Gaya bahasa  santai          Jam tenang   21.00–06.00
Kas          Rp10.000/bulan · jatuh tempo tgl 10 · bendahara @Sari
Lomba        #info-lomba · 2/minggu · RPL, TKJ, PG · promosi: tampil
Janji        ingatkan H-2, H-0 · umumkan yang lewat: ya
Obrolan      nimbrung: aktif · jawab tanpa tag: ya
[🏫 Kelas] [💰 Kas] [🏆 Lomba] [📌 Janji] [💬 Obrolan] [🌙 Jam tenang] [🕘 Riwayat]
```

**Demo:** ketua (bukan admin server) buka `/pengaturan`, ganti gaya bahasa, klik ↩️ Urungkan.

## M8 — Kas yang lengkap & mudah (4–5 hari)

### M8a — Atur kas tanpa ribet
- [ ] Sub-panel 💰 Kas: nominal, periode (mingguan/bulanan), **tanggal jatuh tempo**
      (mis. tgl 10 / hari Jumat; sekarang tahap pengingat dihitung dari tengah & akhir periode),
      bendahara (boleh 2 orang), channel bukti
- [ ] **Riwayat tarif** `kas.rates[{ amount, period, berlakuMulai }]`. Saat ini `/kas atur`
      menimpa nominal, sehingga status lunas periode lama ikut berubah (yang dulu lunas Rp5.000
      jadi "kurang" setelah iuran naik ke Rp10.000). Perubahan berlaku mulai periode berikutnya
      (bisa dipilih "mulai periode ini")
- [ ] **Info pembayaran**: teks rekening/e-wallet + pesan QRIS yang disematkan (bot menyimpan
      referensi pesan, bukan gambar). Bot menampilkannya saat ditanya "transfer ke mana?" atau di
      pengingat. Peringatan di form: jangan pernah menulis PIN/OTP/password
- [ ] **Anggota wajib kas**: default = semua anggota non-bot; pengecualian (wali kelas, alumni,
      akun cadangan) lewat tombol. Anggota baru masuk → bendahara ditanya "ikut kas mulai kapan?"
- [ ] Atur lewat obrolan (bendahara): "iuran jadi 5rb seminggu mulai bulan depan" → kartu diff

### M8b — Mencatat semua jenis uang
- [ ] **Bayar tunai**: "@MIC Budi bayar kas tunai 10rb" (hanya bendahara) atau tombol
      💵 Catat tunai → form (anggota, nominal, catatan)
- [ ] **Bayar beberapa periode / sebagian / lebih**: pembayaran dialokasikan otomatis ke periode
      tertua yang belum lunas (FIFO), sisa jadi deposit periode berikutnya. Fungsi murni
      `allocate(payments, rates, periods)` di `kas/ledger.ts` + test
- [ ] **Pengeluaran**: "@MIC keluar 25rb beli spidol" / `/kas keluar` + foto nota opsional;
      kategori sederhana (perlengkapan, kegiatan, sosial, lain-lain)
- [ ] **Patungan khusus** (dana duka, study tour, kaos kelas): `/kas patungan` → judul, target
      per orang atau total, deadline, peserta. Pakai ledger yang sama dengan `fundId`; bukti
      transfer di channel kas ditanya "untuk kas rutin atau patungan X?" kalau ada patungan aktif
- [ ] **Antrian verifikasi** `/kas antrian`: semua bukti `pending` dalam satu pesan,
      tombol ✅/❌ per baris; ringkasan harian ke DM bendahara kalau antrian > 0

### M8c — Transparan tanpa mempermalukan
- [ ] `/kas saldo` & jawaban obrolan "saldo kas berapa?": masuk, keluar, saldo, patungan aktif
- [ ] Laporan bulanan otomatis ke channel kas (default aktif): total masuk/keluar per kategori,
      jumlah lunas/belum — **tanpa nama** kecuali pengurus menyalakan "tampilkan nama di rekap"
- [ ] Pengaturan pengingat: tahap (H-3, jatuh tempo, +3), lewat DM atau channel, hormati jam tenang
- [ ] Ekspor LPJ: CSV ledger + ringkasan per kategori/patungan siap tempel ke laporan
- [ ] Test: alokasi FIFO, riwayat tarif, patungan terpisah dari kas rutin, saldo = Σ ledger

**Demo:** bendahara ketik "iuran 10rb sebulan, jatuh tempo tgl 10" → kartu → simpan. Budi bayar
tunai 30rb → otomatis lunas 3 bulan. "keluar 25rb spidol" → laporan bulanan muncul.

## M9 — Lomba yang gampang dikelola (3–4 hari)

### M9a — Tambah lomba cukup tempel link / poster
- [ ] Kirim link atau poster di #info-lomba (atau `@MIC ada lomba nih <link>`) → bot ekstrak
      `{ judul, penyelenggara, deadline, biaya, jenjang, tag, ringkasan }` → kartu pratinjau
      [✅ Simpan] [✏️ Ubah] [❌ Batal]. `/lomba tambah` tetap ada sebagai cadangan
- [ ] Ambil isi link dengan aman: hanya `https`, tolak IP privat/localhost (cegah SSRF), batas
      waktu 5 dtk & ukuran 1 MB, hanya baca judul/meta/teks — tidak menjalankan skrip
- [ ] Poster → model vision (`LLM_VISION_MODEL`); tanggal relatif/tanpa tahun diselesaikan WIB
- [ ] Deteksi duplikat (link sama / judul mirip) → "sudah ada, mau perbarui?"
- [ ] Usulan anggota → antrian persetujuan pengurus (ketua/sekretaris)

### M9b — Atur posting lomba
- [ ] Sub-panel 🏆 Lomba: channel, frekuensi (0–5/minggu; 0 = hanya saat ditanya),
      hari & jam posting, minimal sisa hari sebelum deadline, jenjang, tampilkan promosi ya/tidak,
      ikut kurasi global ya/tidak
- [ ] Minat kelas: tombol toggle jurusan + tag tambahan ("ctf", "desain", "esai")
- [ ] Atur lewat obrolan: "lomba cukup seminggu sekali hari Senin aja"

### M9c — Dari info jadi aksi
- [ ] Tombol 🙋 Tertarik di kartu lomba → hitungan peminat + pengingat DM H-7 & H-1 ke yang tertarik
- [ ] Tombol 👎 Kurang cocok → bobot tag per kelas turun (relevansi belajar dari umpan balik, sederhana)
- [ ] "Bentuk tim" yang sudah ada: deadline lomba otomatis jadi deadline janji pendaftaran
- [ ] `/lomba kelola`: daftar lomba kelas ini + Ubah/Arsipkan; arsip otomatis setelah deadline
- [ ] Test: parser hasil ekstraksi, penolakan URL privat, duplikat, frekuensi posting, bobot umpan balik

**Demo:** tempel link Hology → kartu terisi otomatis → Simpan → muncul di #info-lomba hari Senin
→ 5 orang klik Tertarik → klik Bentuk tim.

## M10 — Janji, obrolan & jam tenang bisa diatur (2 hari)
- [ ] 📌 Janji: tahap pengingat (H-2/H-1/H-0/+1 masing-masing on/off), umumkan yang lewat
      deadline ya/tidak, jam default kalau deadline tanpa jam (sekarang 20.00)
- [ ] 💬 Obrolan: nimbrung `aktif | hanya kalau di-tag | mati`, jawab pertanyaan tanpa tag ya/tidak,
      channel yang diabaikan bot (mis. #meme), rangkuman harian otomatis (sisa M3)
- [ ] 🌙 Jam tenang (default 21.00–06.00): pengingat terjadwal ditahan lalu dikirim setelah jam
      tenang; balasan langsung ke orang tetap jalan. Satu fungsi `nextAllowedTime()` dipakai
      scheduler janji, kas, dan lomba
- [ ] Test: jam tenang melewati tengah malam, tahap pengingat dimatikan, channel diabaikan

## M11 — Pengaturan lewat obrolan (2–3 hari)
- [ ] Prefilter kata kunci pengaturan (`atur`, `ganti`, `ubah`, `iuran`, `jatuh tempo`, `bendahara`,
      `lomba`, `jam`) + bot di-tag/dibalas → LLM menghasilkan `SettingsPatch` JSON (zod)
- [ ] Prompt di `src/llm/prompts/settings.ts`; LLM **hanya** mengusulkan patch, keputusan tetap
      lewat kartu diff + klik pengurus (LLM tidak pernah menyimpan langsung)
- [ ] Non-pengurus minta ubah pengaturan → dijawab ramah siapa yang bisa mengubahnya
- [ ] Permintaan ambigu → bot bertanya balik satu hal saja ("mulai bulan ini atau bulan depan?")
- [ ] `scripts/eval-settings.ts` (`bun run eval:settings`): ≥ 20 kalimat nyata (santai, krama,
      salah ketik, angka "5rb/5k/lima ribu", permintaan dari non-pengurus, permintaan berbahaya
      seperti "hapus semua data kas") dengan cek otomatis seperti `eval:voice`

---

## Urutan yang disarankan

1. **M5 (siap demo)** tetap dikerjakan dulu kalau tanggal lomba MIC dekat — stabilitas > fitur.
2. **M7** → wajib sebelum M8–M11 (peran, skema, riwayat).
3. **M8a + M8b** → kas paling sering dipakai dan riwayat tarif memperbaiki bug data.
4. **M9a** → efek "wah" paling besar untuk demo (tempel link → kartu lomba jadi).
5. M10, M8c, M9b–c, M11, lalu M6 (pilot) memakai versi ini.

## Keputusan yang masih terbuka (default yang diusulkan)

- Rekap kas menampilkan nama yang belum bayar? **Default: tidak** (sesuai prinsip *ewuh pakewuh*;
  pengingat personal lewat DM).
- Anggota biasa boleh mengusulkan lomba? **Default: boleh, lewat persetujuan pengurus.**
- Jam tenang default **21.00–06.00 WIB**, bisa diubah per kelas.
- Riwayat pengaturan disimpan **180 hari**.

## WhatsApp (Baileys) — 🧪 kode ada, ditunda
- [x] Adapter: balas angka, form balasan, perintah teks, bukti kas via chat pribadi, routing scheduler
- [ ] Pairing nomor bot berhasil & uji live di grup (gagal pada percobaan pertama 27 Okt; dev lanjut di Discord)
- [ ] Jawaban jujur di pitch soal batas platform (Baileys tidak resmi, risiko blokir nomor)

## Setelah lomba
- Panel pengaturan dirender "balas 1/2/3" di WhatsApp
- Scraper info lomba, sinkron Google Calendar/Notion
- Dasbor web read-only untuk bendahara (ekspor LPJ), tetap tanpa dasbor guru
