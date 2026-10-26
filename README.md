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
| M5 Siap demo · M6 Pilot di kelas | 🚧 berikutnya |
| Fase 2 — Gampang diatur (panel `/pengaturan`, kas lengkap, lomba dari link/poster) | 📋 direncanakan (M7–M11) |
| Adapter WhatsApp (Baileys) | 🔜 setelah lomba |

Detail tiap milestone dan checklist-nya ada di [`PLAN.md`](PLAN.md) dan tab **Milestones / Issues** repo ini.

## Dokumentasi

| Dokumen | Untuk |
|---|---|
| [`PLAN.md`](PLAN.md) | Roadmap & milestone (sumber kebenaran apa yang sedang dikerjakan) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Alur pesan, folder, data, LLM, scheduler |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup dev, alur branch/PR, gaya commit, aturan arsitektur |
| [`SECURITY.md`](SECURITY.md) | Rahasia, privasi data, cara melapor celah |
| [`CHANGELOG.md`](CHANGELOG.md) | Riwayat perubahan per versi |
| [`CLAUDE.md`](CLAUDE.md) | Aturan proyek (juga dibaca Claude Code) |

## Tech stack

Bun · TypeScript strict · discord.js v14 · MongoDB + Mongoose · zod · OpenRouter (default
`z-ai/glm-5.3-flash`) · Docker Compose

## Fitur yang sudah jalan

| Fitur | Cara pakai |
|---|---|
| Deteksi janji dari obrolan | ketik biasa: *"aku yang bikin PPT ya, Jumat jadi"* → tombol ✅ / ✏️ / ❌ |
| Tagihan bertahap | H-2 / H-1 / H-0 lewat DM (cadangan: channel), lewat deadline → diumumkan ke grup |
| Tingkat tutur | `santai`, `sopan`, `krama` (Jawa), dipilih saat wawancara setup |
| Janji & rapor | `/janji list`, `/janji selesai`, `/rapor-kelas` (skor di level kelas saja) |
| Kas kelas | `/kas atur`, kirim foto bukti di channel kas → cek duplikat/nominal/tanggal → bendahara ✅/❌, `/kas rekap`, `/kas ekspor` (CSV) |
| Rangkuman | `/rangkum jam:3` (pesan mentah disimpan maks. 48 jam, TTL index) |
| Info lomba | maks. 2 posting/minggu sesuai jurusan, tombol 👥 *Bentuk tim* → thread + janji awal, `/lomba list`, `/lomba tambah` |
| Nimbrung & suasana | bot menanggapi janji seperti teman sekelas, menyesuaikan nada (santai/serius/tegang/sedih) |
| Tanya jawab | *"ada tugas gak nih?"*, *"kas aku udah lunas?"*, *"ada lomba ga?"* — dijawab dari data, tanpa perlu tag |
| Konfirmasi ketik | balas *"jadi dong, besok"* / *"ga jadi"* selain lewat tombol |

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
```

CI GitHub Actions menjalankan typecheck, lint, dan test di setiap push/PR. Panduan lengkap:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
