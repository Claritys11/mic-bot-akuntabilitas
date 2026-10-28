# Bot Akuntabilitas Kelas (MIC)

Bot yang tinggal di grup kelas dan mengambil peran yang dihindari semua orang: **menagih** — dengan
*unggah-ungguh*.

> Proyek lomba **MIC (Moklet Idea Challenge)** — bidang Teknologi Digital. Tema kearifan lokal:
> *ewuh pakewuh* (sungkan menegur) adalah masalahnya, *unggah-ungguh* adalah cara bot berbicara,
> *gotong royong / kas bersama* adalah praktik yang didukung.

## Status pengembangan

| Bagian | Status |
|---|---|
| Fase 1 — MVP Discord (janji, tagihan, kas, rangkuman, info lomba) | ✅ prototipe jalan di server uji |
| Bot terasa manusiawi (nimbrung, baca suasana, jawab "ada tugas?") | ✅ v0.2.0 |
| M6 Pilot di kelas (+ kelas kontrol) | 🚧 prioritas sekarang — [`docs/PILOT.md`](docs/PILOT.md) |
| M5 Siap demo | 🚧 paralel dengan pilot |
| Fase 2 — Gampang diatur (panel `/pengaturan`, kas lengkap, lomba dari link/poster) | ❄️ dibekukan sampai ada data pilot |
| Adapter WhatsApp (Baileys) | 🧪 kode ada (`src/adapters/whatsapp`), belum tersambung live — nonaktif default; pengembangan sementara di Discord |

Detail tiap milestone dan checklist-nya ada di [`PLAN.md`](PLAN.md) dan tab **Milestones / Issues** repo ini.

## Dokumentasi

| Dokumen | Untuk |
|---|---|
| [`PLAN.md`](PLAN.md) | Roadmap & milestone (sumber kebenaran apa yang sedang dikerjakan) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Alur pesan, folder, data, LLM, scheduler |
| [`docs/PILOT.md`](docs/PILOT.md) | Rencana pilot, kelas kontrol, metrik, holdout deteksi janji |
| [`docs/DEMO.md`](docs/DEMO.md) | Skrip demo 5 menit untuk juri + `bun run demo:check` |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup dev, alur branch/PR, gaya commit, aturan arsitektur |
| [`SECURITY.md`](SECURITY.md) | Rahasia, privasi data, cara melapor celah |
| [`CHANGELOG.md`](CHANGELOG.md) | Riwayat perubahan per versi |
| [`CLAUDE.md`](CLAUDE.md) | Aturan proyek (juga dibaca Claude Code) |

## Tech stack

Bun · TypeScript strict · discord.js v14 · MongoDB + Mongoose · zod · OpenRouter (default
`z-ai/glm-5.3-flash`) · Docker Compose

## Cara pakai dalam 1 menit

**Pengurus (sekali saja):** undang bot → bot menyapa dan mewawancarai (nama kelas, jurusan, gaya bahasa,
channel, iuran kas, bendahara, dan **tempat cek bukti kas: DM bendahara atau channel `#tim-inti`** yang
dicari/dibuatkan otomatis, privat). Selesai — tidak perlu hafal perintah.

**Semua siswa — cukup ngobrol:**

| Ketik di grup | Yang terjadi |
|---|---|
| *"aku yang bikin PPT, jumat"* | dicatat & diingatkan H-2 → H-0; kalau lewat, ditanya kabarnya lewat DM (hari ke-1 & ke-4); tanpa kabar seminggu → dirapikan dari daftar tanpa diumumkan |
| *"ada tugas gak?"* · *"kas aku udah lunas?"* · *"ada lomba ga?"* | dijawab dari catatan |
| *"@MIC ingetin aku besok jam 7 bawa proyektor"* | diingatkan lewat DM tepat waktunya |
| *"jangan lupa besok bawa kartu pelajar ya"* (tanpa tag) | bot menawarkan diri: **⏰ Iya, ingetin** / **Nggak usah** — baru aktif setelah diiyakan penulisnya; teman lain bisa klik **🙋 Ingetin aku juga** |
| foto bukti transfer di channel kas | bot menilai dulu: bukti asli → dicek bendahara di `#tim-inti` (hasil lewat DM); meme/foto lain → dibalas santai di tempat; nota belanja → diarahkan ke `/kas keluar`; buram → minta ulang. Salah nilai? pengirim klik **📨 Ini beneran bukti** |
| *"@MIC ada lomba nih https://…"* | bot membaca halamannya, pengurus tinggal klik 💾 Simpan |
| *"@MIC bisa apa aja?"* atau `/bantuan` | panduan singkat |

Bot juga bertindak seperti teman: menanyakan lagi janji yang belum dijawab, mengirim rangkuman Senin pagi,
dan mengambil info lomba/beasiswa baru dari internet setiap hari.

## Fitur yang sudah jalan

| Fitur | Cara pakai |
|---|---|
| Deteksi janji dari obrolan | ketik biasa: *"aku yang bikin PPT ya, Jumat jadi"* → janji jelas + ada deadline langsung dicatat (salah tangkap? balas *"bukan"*); kurang jelas → ditanya dulu ✅ / ✏️ / ❌ |
| Tagihan bertahap | H-2 / H-1 / H-0 lewat DM (cadangan: channel), lewat deadline → diumumkan ke grup |
| Tingkat tutur | `santai`, `sopan`, `krama` (Jawa), dipilih saat wawancara setup |
| Janji & rapor | `/janji list`, `/janji selesai`, `/rapor-kelas` (skor di level kelas saja) |
| Laporan kas Google Sheets | Bot menawarkan & membuatkan sheet di Drive bendahara (login Google lewat kode); `/kas sheet` — Ringkasan, Buku Kas, Status Iuran, Bukti Transfer diperbarui otomatis; `/kas keluar`, `/kas masuk` untuk arus kas lain |
| Kas kelas | `/kas atur`, kirim foto bukti di channel kas → cek duplikat/nominal/tanggal → bendahara ✅/❌, `/kas rekap`, `/kas ekspor` (CSV) |
| Rangkuman | `/rangkum jam:3` (pesan mentah disimpan maks. 48 jam, TTL index) |
| Info lomba | maks. 2 posting/minggu sesuai jurusan, tombol 👥 *Bentuk tim* → thread + janji awal, `/lomba list`, `/lomba tambah link:…` (dibaca otomatis) |
| Data lomba otomatis | feed RSS harian (`LOMBA_FEEDS`, default lombasma.com & indbeasiswa.com) + link yang ditempel; AI menyaring lomba/beasiswa SMA/SMK yang masih buka; `bun run lomba:ambil` |
| Bendahara & tim inti | `/kas atur cek_bukti:dm\|channel`, `tambah_tim`/`hapus_tim`; channel `#tim-inti` dicari/dibuatkan privat |
| Pengingat & tindak lanjut | `@MIC ingetin …` / `/ingetin`, tanya ulang janji yang belum dijawab, tanya kabar setelah lewat deadline, rangkuman Senin |
| Nimbrung & suasana | bot menanggapi janji seperti teman sekelas, menyesuaikan nada (santai/serius/tegang/sedih) |
| Tanya jawab | *"ada tugas gak nih?"*, *"kas aku udah lunas?"*, *"ada lomba ga?"* — dijawab dari data, tanpa perlu tag |
| Konfirmasi ketik | balas *"jadi dong, besok"* / *"ga jadi"* selain lewat tombol |
| Pilot | `/pilot mode diam` (baseline) · `aktif` · `jeda` (rem darurat), `/pilot ekspor` |
| Privasi | `/data hapus-saya`, `/data hapus-anggota`, `/data hapus-kelas` |

Tanpa API key LLM, deteksi janji tetap jalan memakai heuristik. Rangkuman dan pembacaan bukti
transfer butuh LLM.

## Menjalankan

### 1. Buat bot Discord BARU

Bot ini terpisah dari bot Hermes utamamu, jadi token dan memorinya juga terpisah.

1. https://discord.com/developers/applications → **New Application** → tab **Bot** → *Reset Token* → salin ke `DISCORD_TOKEN`.
2. Nyalakan **Message Content Intent** dan **Server Members Intent**.
3. `DISCORD_CLIENT_ID` opsional — Application ID dibaca otomatis saat login.
4. Undang ke server: jalankan bot, lalu buka link undangan yang dicetak di log (scope `bot` +
   `applications.commands`, permission minimal + **Manage Channels** untuk membuat channel saat setup; sengaja tidak memakai Administrator).
   Kalau halaman undangan macet di "Opening Discord App", tutup dulu klien desktop yang memakai arRPC
   (mis. Vesktop) lalu muat ulang.
5. `DISCORD_GUILD_ID` opsional. Kosong = slash command didaftarkan per server tempat bot berada (langsung muncul). Kalau bot belum diundang ke server mana pun, log menampilkan link undangan.

### 2. Isi `.env`

```bash
cp .env.example .env   # lalu isi
```

### 3. Jalankan

```bash
docker compose up -d          # bot + mongo
# atau lokal:
docker compose up -d mongo && bun install && bun dev
```

Begitu masuk server, bot menyapa dan **mewawancarai admin** dengan bahasa santai: nama kelas, jurusan
(boleh campur, mis. `RPL, TKJ, PG`), gaya bahasa, mau dibuatkan channel `#kas-kelas` & `#info-lomba`
atau tidak, iuran kas, dan bendahara. Ulang kapan saja dengan tag bot + "setup ulang" atau `/setup`
tanpa opsi. Cara cepat tetap ada: `/setup kelas:"XI RPL 2" jurusan:RPL tutur:sopan`.

### Demo dipercepat

`DEMO_TIME_SCALE=1440` berarti 1 menit nyata = 1 hari, jadi tagihan H-2 sampai lewat deadline untuk janji
"Jumat" muncul dalam beberapa menit. Jam virtual kembali normal setelah restart.

## Laporan kas di Google Sheets

Catatan kas utama tetap di database bot (buku kas append-only). Google Sheet adalah **laporan otomatis**
untuk bendahara/LPJ: tab *Ringkasan*, *Buku Kas* (saldo berjalan), *Status Iuran* (6 periode), dan
*Bukti Transfer* diperbarui ±1 menit setelah ada iuran disetujui, bukti masuk/ditolak, `/kas keluar`,
`/kas masuk`, atau perubahan iuran.

### Cara utama: bot yang membuatkan (disarankan)

Bendahara tidak perlu membuat atau membagikan apa pun. Setelah iuran kas diatur, bot menawarkan sekali
(di channel tim inti, atau DM bendahara) tombol **📊 Buatkan laporan Google Sheets** — juga ada di `/kas sheet`.
Yang menekan mendapat 3 langkah (hanya terlihat olehnya): buka `google.com/device` → masukkan kode → pilih akun
Google → **Izinkan**. Bot lalu membuat spreadsheet **di Google Drive bendahara sendiri**, mengisinya, dan
mengirim linknya lewat DM. Izin yang diminta hanya `drive.file`: bot cuma bisa menyentuh file yang ia buat,
bukan isi Drive lainnya.

- Login Google disimpan sebagai refresh token **terenkripsi** (AES-256-GCM, kunci `SECRET_KEY`).
- `/kas sheet link:putus` → berhenti memperbarui dan izin Google dicabut (isi sheet tetap milik pemiliknya).
- Pemilik sheet dicopot dari bendahara/tim inti kas, atau datanya dihapus → bot berhenti menulis ke Drive-nya.
- Sheet dibuat publik ("siapa saja yang punya link") → bot berhenti mengisi sampai aksesnya dibatasi lagi.

**Sekali saja (operator bot):**
1. [console.cloud.google.com](https://console.cloud.google.com) → buat project → *APIs & Services* → aktifkan
   **Google Sheets API** dan **Google Drive API**.
2. *OAuth consent screen* (Google Auth Platform): tipe **External**, isi nama aplikasi & email, scope cukup
   `…/auth/drive.file`, lalu **Publish app** (status *In production*). Jangan biarkan di *Testing*: di mode itu
   hanya akun yang didaftarkan yang bisa login dan izinnya kedaluwarsa tiap 7 hari. `drive.file` termasuk scope
   non-sensitif, jadi tidak perlu verifikasi Google.
3. *Credentials → Create credentials → OAuth client ID* → tipe **TVs and Limited Input devices**.
4. `.env`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, dan `SECRET_KEY` (acak ≥ 32 karakter,
   mis. `openssl rand -base64 48`). Simpan `SECRET_KEY` baik-baik — kalau hilang/berganti, semua kelas perlu
   login Google ulang. Restart bot.

### Cara manual (akun layanan, opsional)

Untuk sekolah yang ingin sheet dibuat sendiri lalu dibagikan ke bot:
1. Di project yang sama: *IAM & Admin → Service Accounts* → buat akun layanan → *Keys* → *Add key* → **JSON**
   → simpan sebagai `data/google-service-account.json` (folder `data/` tidak ikut git — kunci ini rahasia).
2. `.env`: `GOOGLE_SERVICE_ACCOUNT_FILE=./data/google-service-account.json`, lalu restart bot.
3. Per kelas: buat Google Sheet ([sheets.new](https://sheets.new)) → **Bagikan** ke email akun layanan sebagai
   **Editor**, *Akses umum* = **Dibatasi** → `/kas sheet link:https://docs.google.com/spreadsheets/d/…`.

Nilai ditulis apa adanya (tanpa formula). Sheet berisi nama & status bayar anggota — bagikan hanya ke pengurus.

## WhatsApp (eksperimental)

Baileys = WhatsApp Web tidak resmi; pakai **nomor khusus bot**, nomornya bisa diblokir WhatsApp.

```
WHATSAPP_ENABLED=true
WA_PHONE_NUMBER=62812xxxxxxx   # nomor bot, angka saja
```

Saat pertama jalan, log mencetak **kode pairing**. Di HP nomor bot: WhatsApp → Perangkat tertaut →
Tautkan perangkat → "Tautkan dengan nomor telepon saja" → masukkan kode (berlaku beberapa menit;
siapkan HP dulu sebelum menjalankan bot). Sesi tersimpan di `data/wa-auth` (rahasia, di `.gitignore`).

Perbedaan dengan Discord: tombol → *balas angka*, form → balas template `Label: isi`, slash command →
perintah teks (`/janji list`, `/kas rekap`, `/bantuan`), bukti kas boleh lewat chat pribadi ke bot.

## LLM: OpenRouter atau Hermes (profil terpisah)

Bot memakai klien **OpenAI-compatible** (`src/llm/openrouter.ts`), jadi backend-nya cukup diganti
lewat `LLM_BASE_URL`.

**Mode A — OpenRouter (default, disarankan untuk privasi).** Default `z-ai/glm-5.3-flash` untuk teks
dan gambar (murah, ~2 detik per balasan). Tanpa kredit bisa pakai model `:free`. Setiap panggilan stateless, jadi tidak ada memori sama
sekali dan tidak bercampur dengan Hermes Agent milikmu.

**Cadangan otomatis.** `LLM_TEXT_MODEL` / `LLM_VISION_MODEL` boleh berisi beberapa model dipisah koma,
dan `BACKUP_OPENROUTER_API_KEY` dipakai kalau key utama ditolak. Bot mencoba tiap model × key
berurutan; kombinasi yang kena limit diistirahatkan 10 menit (rate limit: 1 menit). Contoh:

```
LLM_TEXT_MODEL=z-ai/glm-5.3-flash,dots-studio/dots-3-note-preview:free
LLM_VISION_MODEL=z-ai/glm-5.3-flash
```

Model berbayar butuh kredit OpenRouter **dan** batas belanja key > $0 (Settings → Keys). Model `:free`
jalan tanpa kredit tapi sering kena rate limit, jadi taruh di belakang sebagai cadangan.

**Mode B — Hermes Agent lokal, profil `mic` yang fresh.**
Profil Hermes punya `HERMES_HOME` sendiri: memori, sesi, dan skill terpisah. Gateway Discord utamamu
tidak tersentuh, dan token bot Discord tidak ikut tersalin.

```bash
bash scripts/hermes-profile.sh mic 8643   # buat profil, hapus memori hasil clone, matikan memori, aktifkan API server
hermes -p mic gateway                      # jalankan (terpisah dari gateway utama)
```

Lalu isi `.env` sesuai output skrip (`LLM_BASE_URL=http://localhost:8643/v1`, `LLM_TEXT_MODEL=hermes-agent`,
`LLM_JSON_MODE=false`). Catatan:
- `--clone` di Hermes ikut menyalin `MEMORY.md`/`USER.md`. Skrip menghapusnya dan mematikan
  `memory.memory_enabled` agar obrolan kelas tidak menumpuk di memori agent.
- Hermes Agent tetap menyimpan transkrip sesi di `state.db` profil itu. Untuk prinsip privasi
  (pesan mentah ≤ 48 jam), Mode A lebih bersih.
- Model utama Hermes-mu mungkin tidak mendukung gambar, jadi vision (bukti transfer) bisa tetap
  lewat OpenRouter: `LLM_VISION_BASE_URL` + `LLM_VISION_API_KEY`.

## Arsitektur

```
Discord ──► adapters/discord ──IncomingMessage──► core ──OutgoingMessage/Reply──► adapters/discord ──► Discord
                                                   │  (tanpa discord.js; eslint melarang import-nya)
                         scheduler (poll 60 dtk) ──┤── db (Mongo): Promise, KasProof, Transaction (append-only), …
                                                   └── llm (OpenAI-compatible): OpenRouter / Hermes Agent
```

- `Action { id, label, kind }` → Discord: tombol, WhatsApp nanti: "balas 1/2/3".
- `Form` → Discord: modal.
- Mention ditulis sebagai token `{{@userId}}`; adapter yang merendernya.
- Scheduler menyimpan tahap tagihan di DB (klaim atomik `findOneAndUpdate`), jadi aman restart
  dan tidak dobel kirim.

## Pengembangan

```bash
bun test          # parser tanggal, eskalasi, template, prefilter, ledger, verifikasi, relevansi
bun run typecheck
bun run lint
bun simulate      # simulasi end-to-end core + Mongo tanpa Discord (DB mic_sim), tambah --llm untuk pakai LLM
bun run eval:voice  # uji suara bot (janji & tanya jawab) ke LLM sungguhan, tidak menyentuh DB
bun run demo:check  # cek sebelum demo: Mongo, LLM teks & vision, mode diam, DEMO_TIME_SCALE
bun run pilot:metrics -- --dari 2026-11-02 --sampai 2026-11-20   # metrik pilot, biaya LLM, masa bot mati
bun run holdout prepare|label|eval …   # ukur akurasi deteksi janji pada chat asli (lihat docs/PILOT.md)
bash scripts/backup.sh  # backup Mongo (pasang di cron harian)
```

CI GitHub Actions menjalankan typecheck, lint, dan test di setiap push/PR. Panduan lengkap:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
