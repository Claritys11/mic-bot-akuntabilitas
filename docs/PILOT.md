# Rencana Pilot

Tujuan: menguji asumsi paling berisiko **sebelum** menambah fitur (Fase 2 dibekukan sampai ada data):

> Apakah bot yang mencatat & menagih janji membuat siswa lebih sering menepati janji kelompok,
> dibanding kelas tanpa bot?

Kalau jawabannya "tidak", fitur pengaturan secanggih apa pun tidak menolong. Kalau "ya", angka ini
jadi bukti terkuat di depan juri MIC.

## Desain

| | Kelas pilot | Kelas kontrol |
|---|---|---|
| Jumlah | 1 kelas (± 30–36 siswa) | 1 kelas setingkat, jurusan mirip |
| Platform | Discord (bot aktif) | grup biasa tanpa bot |
| Durasi | 2–3 minggu kalender | sama |
| Pencatatan janji | otomatis oleh bot | ketua/sekretaris mencatat manual di lembar sederhana |

Lembar kontrol (Google Sheet): `tugas · pemilik · deadline · tanggal selesai (kosong kalau belum)`.
Cukup janji kelompok yang disebut di grup — sama dengan yang bot catat di kelas pilot.

## Persetujuan & privasi (sebelum mulai)

- Formulir persetujuan wali murid (Google Form/kertas): apa yang dicatat, berapa lama, siapa yang bisa melihat.
- Bot sudah: pesan mentah ≤ 48 jam, tanpa skor individu publik, detail bukti kas dihapus setelah ditinjau,
  OpenRouter `data_collection=deny`. Sampaikan ini di formulir.
- Hanya data kelas; tidak ada dasbor guru.

## Metrik

Dihitung dengan `bun run pilot:metrics --dari 2026-11-02 --sampai 2026-11-20`:

| Metrik | Arti | Target awal |
|---|---|---|
| Ditepati tepat waktu (%) | selesai ≤ deadline / janji yang jatuh tempo | pilot ≥ kontrol + 15 poin |
| Rata-rata hari telat | untuk yang selesai terlambat | pilot < kontrol |
| Janji tercatat | volume yang terlacak | ≥ 15 janji selama pilot |
| Ditanya tapi tak dikonfirmasi | janji yang "lolos" pelacakan | turun setelah auto-aktif |
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
| 0 | Persetujuan wali, pilih kelas pilot & kontrol, pasang bot, siapkan lembar kontrol |
| 1–3 | Pilot berjalan; M5 (siap demo) dikerjakan paralel; cek log & salah-aktif tiap 2–3 hari |
| 3 | Hitung metrik, wawancara 5–10 ketua/bendahara, ukur holdout |
| 4 | Putuskan: lanjut Fase 2 / ubah arah; masukkan angka ke proposal MIC |
