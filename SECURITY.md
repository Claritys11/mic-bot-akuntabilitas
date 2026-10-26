# Keamanan & Privasi

## Melaporkan celah

Repo ini privat. Laporkan celah langsung ke maintainer (pemilik repo) lewat DM atau
[security advisory privat](../../security/advisories/new). Jangan membuka issue biasa untuk celah
yang bisa disalahgunakan.

## Rahasia

- `.env` tidak pernah di-commit (lihat `.gitignore`). Gunakan `.env.example` sebagai acuan.
- Token Discord, key OpenRouter, dan URI database hanya di `.env` / secret deploy.
- Token sempat bocor? **Reset segera** di Discord Developer Portal / OpenRouter, lalu beri tahu tim.
- Setiap developer memakai bot Discord dev sendiri.

## Prinsip yang dijaga kode

| Area | Penerapan |
|---|---|
| Izin bot | Tanpa Administrator; hanya izin minimal + Manage Channels (untuk membuat channel saat setup) |
| Mention | `allowedMentions` hanya user yang disebut eksplisit; `@everyone`/`@here` dari LLM ditolak |
| Injeksi | `sanitize()` menetralkan setiap `{` agar teks user/LLM tidak bisa menyelipkan token mention |
| Isolasi server | Info lomba tambahan admin hanya untuk server itu; konfirmasi janji hanya oleh pemiliknya |
| Key LLM | Key cadangan OpenRouter hanya dikirim ke host `openrouter.ai` |
| Output LLM | Divalidasi zod; link & mention massal ditolak; gagal → template/heuristik |
| Uang | Bot tidak memegang uang — hanya mencatat & memverifikasi; ledger append-only |

## Data yang disimpan

- **Permanen:** janji, transaksi & bukti kas, info lomba, profil kelas, daftar anggota (nama tampilan).
- **Sementara:** pesan mentah obrolan (TTL **48 jam**, terhapus otomatis), state wawancara setup (3 hari).
- **Tidak ada** dasbor guru atau skor individu publik; skor ketepatan janji hanya di level kelas.
- Rekap kas di grup tidak menyebut nama yang belum bayar; pengingat personal lewat DM.
