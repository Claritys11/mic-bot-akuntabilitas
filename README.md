# Bot Akuntabilitas Kelas (MIC)

Bot yang tinggal di grup kelas dan mengambil peran yang dihindari semua orang: **menagih** — dengan
*unggah-ungguh*. Lihat `CLAUDE.md` (aturan) dan `PLAN.md` (milestone).

## Fitur prototipe

| Fitur | Cara pakai |
|---|---|
| Deteksi janji dari obrolan | ketik biasa: *"aku yang bikin PPT ya, Jumat jadi"* → tombol ✅ / ✏️ / ❌ |
| Tagihan bertahap | H-2 / H-1 / H-0 lewat DM (cadangan: channel), lewat deadline → diumumkan ke grup |
| Tingkat tutur | `santai`, `sopan`, `krama` (Jawa), dipilih saat wawancara setup |
| Janji & rapor | `/janji list`, `/janji selesai`, `/rapor-kelas` (skor di level kelas saja) |
| Kas kelas | `/kas atur`, kirim foto bukti di channel kas → cek duplikat/nominal/tanggal → bendahara ✅/❌, `/kas rekap`, `/kas ekspor` (CSV) |
| Rangkuman | `/rangkum jam:3` (pesan mentah disimpan maks. 48 jam, TTL index) |
| Info lomba | maks. 2 posting/minggu sesuai jurusan, tombol 👥 *Bentuk tim* → thread + janji awal, `/lomba list`, `/lomba tambah` |

Tanpa API key LLM, deteksi janji tetap jalan memakai heuristik. Rangkuman dan pembacaan bukti
transfer butuh LLM.

## Menjalankan

### 1. Buat bot Discord BARU

Bot ini terpisah dari bot Hermes utamamu, jadi token dan memorinya juga terpisah.

1. https://discord.com/developers/applications → **New Application** → tab **Bot** → *Reset Token* → salin ke `DISCORD_TOKEN`.
2. Nyalakan **Message Content Intent** dan **Server Members Intent**.
3. `DISCORD_CLIENT_ID` opsional — Application ID dibaca otomatis saat login.
4. Undang ke server: jalankan bot, lalu buka link undangan yang dicetak di log (scope `bot` +
   `applications.commands`, permission **Administrator** — dipakai untuk membuat channel saat setup).
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

**Mode A — OpenRouter (default, disarankan untuk privasi).** Dev memakai model `:free`; untuk prod
ganti ke model berbayar, mis. `LLM_TEXT_MODEL=nousresearch/hermes-4-405b`. Setiap panggilan stateless, jadi tidak ada memori sama
sekali dan tidak bercampur dengan Hermes Agent milikmu.

**Cadangan otomatis.** `LLM_TEXT_MODEL` / `LLM_VISION_MODEL` boleh berisi beberapa model dipisah koma,
dan `BACKUP_OPENROUTER_API_KEY` dipakai kalau key utama ditolak. Bot mencoba tiap model × key
berurutan; kombinasi yang kena limit diistirahatkan 10 menit (rate limit: 1 menit). Contoh prod:

```
LLM_TEXT_MODEL=nousresearch/hermes-4-405b,dots-studio/dots-3-note-preview:free
LLM_VISION_MODEL=google/gemini-2.5-flash,dots-studio/dots-3-note-preview:free
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
```
