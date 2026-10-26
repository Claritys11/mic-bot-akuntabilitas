## Apa yang berubah

<!-- Ringkas. Tautkan issue: Closes #… -->

## Milestone

<!-- mis. M8a — Atur kas tanpa ribet -->

## Cara mencoba

<!-- Langkah di server Discord dev / perintah simulate -->

## Checklist

- [ ] `bun test`, `bun run typecheck`, `bun run lint` lulus
- [ ] Test ditambahkan untuk logika core baru
- [ ] `src/core` tidak import discord.js; tombol/form memakai `Action`/`Form`
- [ ] Teks dari user/LLM lewat `sanitize()`; tidak ada rahasia di diff
- [ ] Mengubah prompt/kalimat bot → `bun run eval:voice` sudah dijalankan
- [ ] `PLAN.md` / `CHANGELOG.md` diperbarui kalau perlu
