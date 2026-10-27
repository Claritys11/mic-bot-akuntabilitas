# Rencana Pilot

Tujuan: menguji asumsi paling berisiko **sebelum** menambah fitur (Fase 2 dibekukan sampai ada data):

> Apakah bot yang mencatat & menagih janji membuat siswa lebih sering menepati janji kelompok,
> dibanding kelas tanpa bot?

Kalau jawabannya "tidak", fitur pengaturan secanggih apa pun tidak menolong. Kalau "ya", angka ini
jadi bukti terkuat di depan juri MIC.

## Desain: kelas sebagai kontrolnya sendiri

Satu kelas lawan satu kelas kontrol dengan ±15 janji tidak bermakna — beda karakter antarkelas lebih
besar daripada efek bot. Maka satu kelas dibandingkan dengan dirinya sendiri:

| Minggu | Mode bot | Yang terjadi |
|---|---|---|
| 1 | `/pilot mode diam` | Bot hanya **mencatat** janji dari obrolan (tidak membalas, tidak menagih, tidak ada pengingat kas/lomba) → baseline |
| 2–3 | `/pilot mode aktif` | Bot normal: nimbrung, auto-aktif, menagih bertahap |

- Janji dari minggu diam disimpan sebagai `shadow` dan **tidak pernah ditagih**, supaya baseline bersih.
- Akhir tiap fase: `/pilot ekspor` → CSV. Ketua kelas mengecek **sampel acak** (mis. 10 janji) dan mengisi
  kolom `dicek_ketua_ditepati` (ya/tidak). Tombol "selesai" dari pemilik adalah *self-report*, jadi tidak
  dipakai sendirian sebagai bukti.
- Kalau ada kelas kedua yang mau, boleh dijadikan pembanding tambahan, tapi bukan syarat.
- Laporkan angka apa adanya **beserta ukuran sampel** sebagai *hasil awal*, bukan bukti kausal.

## Checklist sebelum minggu diam dimulai

- [ ] Formulir persetujuan wali terkumpul. Sebutkan hak menarik persetujuan (`/data hapus-saya`) dan bahwa
      data yang dihapus **hilang permanen paling lambat 14 hari** (masa simpan backup).
- [ ] `OPERATOR_DISCORD_ID` diisi → kamu dapat DM kalau bot sempat mati atau scheduler macet.
- [ ] Backup harian aktif: `crontab -e` → `0 2 * * * cd /path/repo && bash scripts/backup.sh >> backups/backup.log 2>&1`.
      Simpan di disk terenkripsi dan jangan di folder yang tersinkron (Google Drive/Dropbox dll.).
- [ ] Pengurus tahu rem darurat: `/pilot mode jeda` menghentikan bot seketika di kelas itu.
- [ ] `bun run demo:check` lulus; lalu `/pilot mode diam`.

Bot yang mati lebih dari 30 menit dicatat otomatis dan muncul di `bun run pilot:metrics`. Kalau bot mati
lebih dari sehari di minggu diam, pertimbangkan memperpanjang baseline.

## Persetujuan & privasi (sebelum mulai)

- Formulir persetujuan wali murid (Google Form/kertas): apa yang dicatat, berapa lama, siapa yang bisa melihat.
- Bot sudah: pesan mentah ≤ 48 jam, tanpa skor individu publik, detail bukti kas dihapus setelah ditinjau,
  OpenRouter `data_collection=deny`. Sampaikan ini di formulir.
- Hanya data kelas; tidak ada dasbor guru.
- Menarik persetujuan: siswa `/data hapus-saya`; pengurus `/data hapus-anggota` atau `/data hapus-kelas`
  (dua langkah, permanen; catatan kas dianonimkan agar saldo kelas tetap benar).

## Metrik

Dihitung dengan `bun run pilot:metrics --dari 2026-11-02 --sampai 2026-11-20` (baseline & aktif dipisah):

| Metrik | Arti | Target awal |
|---|---|---|
| Janji tercatat | volume yang terlacak selama 3 minggu | 30 (minimum 15) |
| Ditepati tepat waktu (%) | dari cek sampel ketua: baseline vs aktif | aktif lebih tinggi; laporkan selisih + n |
| Rata-rata hari telat | untuk yang selesai terlambat | aktif lebih rendah |
| Ditanya tapi tak dikonfirmasi | janji yang "lolos" pelacakan saat aktif | sekecil mungkin |
| Salah-aktif (%) | auto-aktif lalu "bukan janjiku" | ≤ 10% |
| Kas tercatat vs buku kas | bukti disetujui dibanding catatan bendahara | selisih 0 |

## Mengukur deteksi janji secara jujur (holdout)

Set berlabel di `test/prefilter.test.ts` dipakai untuk menyetel prefilter, jadi angkanya **bukan**
ukuran akurasi. Ukuran jujur:

1. Dengan persetujuan, ekspor chat grup kelas (WhatsApp → ⋮ → Lainnya → Ekspor chat → Tanpa media) dari 2–3 kelas.
2. Anonimkan sebelum disimpan — nama jadi `Siswa1…`, nomor HP & email dihapus, pemetaan nama tidak disimpan:
   `bun run holdout prepare ekspor.txt data/holdout-kelasA.jsonl` (folder `data/` tidak ikut git).
   Hapus file .txt asli setelahnya.
3. Dua orang melabeli tiap pesan (janji ya/tidak, pemilik, ungkapan deadline): `bun run holdout label data/holdout-kelasA.jsonl`.
   Bedanya dirembukkan.
4. Simpan sebagai holdout — **jangan pernah dilihat saat mengubah prompt/prefilter**.
5. Sekali di akhir pilot: `bun run holdout eval data/holdout-kelasA.jsonl` → precision, recall, F1, ketepatan
   deadline, dan daftar kesalahan (hilang di prefilter / ditolak LLM / salah tangkap).

## Jadwal

| Minggu | Kegiatan |
|---|---|
| 0 | Persetujuan wali, pilih kelas, pasang bot, `/pilot mode diam` |
| 1 | Baseline (diam); akhir minggu: `/pilot ekspor` + cek sampel ketua; lalu `/pilot mode aktif` |
| 2–3 | Bot aktif; M5 (siap demo) dikerjakan paralel; cek log & salah-aktif tiap 2–3 hari |
| 3 | `/pilot ekspor` + cek sampel, `bun run pilot:metrics`, wawancara 5–10 ketua/bendahara, ukur holdout |
| 4 | Putuskan: lanjut Fase 2 / ubah arah; masukkan angka ke proposal MIC |
