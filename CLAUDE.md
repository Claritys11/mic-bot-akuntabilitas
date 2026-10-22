# MIC Bot Akuntabilitas Kelas

Bot AI yang tinggal di grup kelas dan mengambil peran yang dihindari semua orang: **menagih**.
Lomba: MIC (Moklet Idea Challenge), bidang Teknologi Digital. Tema kearifan lokal: *ewuh pakewuh*
(sungkan menegur) adalah masalahnya, *unggah-ungguh* adalah cara bot berbicara, *gotong royong / kas
bersama* adalah praktik yang didukung.

Platform pertama: **Discord**. Platform berikutnya: **WhatsApp (Baileys)** saat nomor dummy tersedia.

## Stack

- Runtime: Bun (fallback Node 18+), TypeScript strict
- Discord: discord.js v14
- DB: MongoDB + Mongoose
- LLM: OpenRouter (OpenAI-compatible API), model diatur lewat env
- Deploy: Docker + docker-compose (bot + mongo)
- Referensi pola: https://github.com/dimasma0305/ctf-assistant (struktur Commands/Events/Database,
  scheduler, notify channel, leaderboard). Ambil pola, jangan copy-paste fitur CTF.

## Arsitektur — ATURAN WAJIB

```
src/
  core/        logika bisnis. DILARANG import discord.js atau baileys di sini.
    types.ts   IncomingMessage, OutgoingMessage, Action (netral platform)
    promises/  deteksi janji, konfirmasi, status
    billing/   aturan eskalasi tagihan + template unggah-ungguh
    kas/       ledger, verifikasi bukti transfer, rekap
    summary/   rangkuman obrolan
    opps/      info lomba/beasiswa + saring relevansi
  adapters/
    discord/   terjemahkan event Discord <-> core; render Action jadi button/embed
    whatsapp/  (nanti) render Action jadi "balas 1/2/3"
  llm/         interface LLMProvider { chat(), vision() }; impl openrouter.ts
  scheduler/   loop polling tiap 60 detik ke koleksi Promise & Reminder (persisten, aman restart)
  db/          skema Mongoose
  config.ts    baca & validasi env (zod)
index.ts
```

- Core menerima `IncomingMessage` dan mengembalikan `OutgoingMessage[]`. Adapter yang mengirim.
- Interaksi (tombol) didefinisikan sebagai `Action { id, label, kind }`, bukan komponen Discord.
- Identitas anggota: `Member { platform, platformUserId, groupId, displayName }`. Jangan pakai ID Discord
  sebagai primary key di logika core.

## Prinsip produk (berpengaruh ke kode)

1. **Tidak menambah langkah.** Fitur utama jalan dari obrolan biasa; slash command hanya cadangan.
2. **Janji harus dikonfirmasi.** Deteksi → bot balas dengan tombol ✅ Konfirmasi / ✏️ Ubah / ❌ Bukan janji.
   Hanya janji terkonfirmasi yang ditagih.
3. **Privasi.** Simpan permanen hanya: janji, transaksi kas, info lomba. Pesan mentah untuk rangkuman
   disimpan di buffer dengan TTL index 48 jam, lalu terhapus otomatis.
4. **Hemat LLM.** Filter regex/kata kunci dulu (`aku yang`, `saya yang`, `jadi`, nama hari, tanggal,
   `deadline`, `besok`, `transfer`, `bayar`). LLM dipanggil hanya untuk pesan yang lolos filter.
5. **Unggah-ungguh.** Tagihan bertahap: H-2 halus → H-0 tegas sopan → lewat deadline diumumkan ke grup.
   Tingkat tutur per grup: `santai | sopan | krama`.
6. **Tidak mengawasi.** Tidak ada dashboard guru. Skor ketepatan janji hanya di level kelas.
7. **Uang tidak dipegang bot.** Bot hanya mencatat dan memverifikasi; transfer tetap lewat bank/e-wallet.

## LLM

- `OPENROUTER_API_KEY`, `LLM_TEXT_MODEL` (mis. model Hermes), `LLM_VISION_MODEL` (model yang
  mendukung input gambar, untuk bukti transfer; Hermes umumnya teks saja).
- Semua ekstraksi minta output **JSON** dan divalidasi dengan zod; kalau gagal parse → abaikan, jangan crash.
- Simpan prompt di `src/llm/prompts/*.ts`, bukan inline.
- Tanggal relatif ("Jumat", "besok") diselesaikan dengan zona waktu Asia/Jakarta.

## Env

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=        # dev: daftarkan command per guild biar instan
MONGODB_URI=
OPENROUTER_API_KEY=
LLM_TEXT_MODEL=
LLM_VISION_MODEL=
TZ=Asia/Jakarta
```

Discord Developer Portal: nyalakan **Message Content Intent** dan **Server Members Intent**.

## Perintah

- `bun install`, `bun dev` (watch), `bun start`, `bun test`
- `docker compose up -d`

## Cara kerja dengan Claude Code

- Kerjakan per milestone di `PLAN.md`. Satu milestone = satu branch/commit yang bisa didemo.
- Tulis test untuk logika core (parser tanggal, aturan eskalasi, ledger) sebelum implementasi.
- Jangan tambah fitur di luar PLAN.md tanpa ditanya.
