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

## Persetujuan & privasi (sebelum mulai)

- Formulir persetujuan wali murid (Google Form/kertas): apa yang dicatat, berapa lama, siapa yang bisa melihat.
- Bot sudah: pesan mentah ≤ 48 jam, tanpa skor individu publik, detail bukti kas dihapus setelah ditinjau,
  OpenRouter `data_collection=deny`. Sampaikan ini di formulir.
- Hanya data kelas; tidak ada dasbor guru.

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

1. Dengan persetujuan, ekspor chat grup kelas (WhatsApp "Ekspor chat" → .txt) dari 2–3 kelas.
2. Hapus nama & nomor (ganti `Siswa1`, `Siswa2`, …) sebelum disimpan.
3. Dua orang melabeli tiap pesan: janji ya/tidak, pemilik, deadline. Bedanya dirembukkan.
4. Simpan sebagai holdout — **jangan pernah dilihat saat mengubah prompt/prefilter**.
5. Hitung precision & recall prefilter + LLM pada holdout sekali di akhir pilot.

## Jadwal

| Minggu | Kegiatan |
|---|---|
| 0 | Persetujuan wali, pilih kelas, pasang bot, `/pilot mode diam` |
| 1 | Baseline (diam); akhir minggu: `/pilot ekspor` + cek sampel ketua; lalu `/pilot mode aktif` |
| 2–3 | Bot aktif; M5 (siap demo) dikerjakan paralel; cek log & salah-aktif tiap 2–3 hari |
| 3 | `/pilot ekspor` + cek sampel, `bun run pilot:metrics`, wawancara 5–10 ketua/bendahara, ukur holdout |
| 4 | Putuskan: lanjut Fase 2 / ubah arah; masukkan angka ke proposal MIC |
