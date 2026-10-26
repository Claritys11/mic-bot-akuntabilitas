# Panduan Kontribusi

Terima kasih sudah ikut mengembangkan bot MIC! Baca ini dulu sebelum membuka PR.

## Persiapan

```bash
git clone git@github.com:Claritys11/mic-bot-akuntabilitas.git
cd mic-bot-akuntabilitas
bun install
cp .env.example .env             # isi token bot Discord DEV milikmu sendiri + key OpenRouter
docker compose up -d mongo
bun dev
```

Pakai **bot Discord & server Discord dev sendiri** untuk mencoba. Jangan memakai token bot produksi
di laptop.

## Alur kerja

1. Ambil issue dari milestone yang sedang berjalan (lihat tab **Milestones** dan [`PLAN.md`](PLAN.md)).
   Belum ada issue? Buat dulu dan diskusikan — kita tidak menambah fitur di luar `PLAN.md` tanpa sepakat.
2. Buat branch dari `main`: `feat/m7-panel-pengaturan`, `fix/kas-riwayat-tarif`, `docs/...`.
3. Tulis test untuk logika core **sebelum** implementasi (parser, aturan eskalasi, ledger, dsb.).
4. Pastikan lulus:
   ```bash
   bun test && bun run typecheck && bun run lint
   bun simulate             # e2e tanpa Discord (butuh Mongo)
   bun run eval:voice       # kalau mengubah prompt / kalimat bot (butuh key OpenRouter)
   ```
5. Buka PR ke `main`, isi template, tautkan issue (`Closes #12`). CI harus hijau.

## Gaya commit

Conventional Commits, isi dalam bahasa Indonesia:

```
feat(kas): catat pembayaran tunai oleh bendahara
fix(janji): tombol hilang setelah dibatalkan
docs(plan): tambah milestone M9
chore(llm): ganti model default
```

Scope yang dipakai: `janji`, `kas`, `lomba`, `obrolan`, `setup`, `pengaturan`, `llm`, `discord`,
`security`, `plan`.

## Aturan arsitektur (wajib)

- `src/core` **dilarang** import `discord.js`/`baileys` — ESLint akan gagal.
- Core menerima `IncomingMessage` dan mengembalikan `OutgoingMessage[]`/`Reply`; adapter yang mengirim.
- Tombol = `Action { id, label, kind }`, form = `Form`. Jangan pakai komponen khusus Discord di core.
- Prompt LLM di `src/llm/prompts/*.ts`, output JSON divalidasi zod, gagal parse → abaikan.
- Teks dari user/LLM yang masuk ke pesan bot harus lewat `sanitize()`; mention lewat `mention()`.
- Ledger kas append-only: koreksi = transaksi baru.
- Pesan mentah hanya boleh di `MessageBuffer` (TTL 48 jam).

Penjelasan lengkap: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Menulis kalimat bot

Bot berbicara seperti teman sekelas, sesuai tingkat tutur grup (`santai | sopan | krama`) dan
suasana (`santai | serius | tegang | sedih`). Tambah variasi di `src/core/promises/voice.ts` atau
`src/core/billing/templates.ts`, dan pastikan versi "netral" tidak berisi tawa/emoji bercanda —
`test/voice.test.ts` memeriksanya.
