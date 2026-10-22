// Seed info lomba untuk demo. Nama & situs penyelenggara nyata; TANGGAL di sini hanya perkiraan
// relatif dari waktu seed — cek ulang di situs resmi sebelum demo ke juri.

export interface SeedOpportunity {
  title: string;
  organizer: string;
  daysFromNow: number;
  tags: string[];
  link: string;
  description: string;
}

export const SEED_OPPORTUNITIES: SeedOpportunity[] = [
  { title: 'LKS SMK — Web Technologies', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 60, tags: ['rpl', 'web', 'programming'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'Lomba Kompetensi Siswa bidang Web Technologies, berjenjang dari kota hingga nasional.' },
  { title: 'LKS SMK — IT Network Systems Administration', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 60, tags: ['tkj', 'jaringan', 'network'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'LKS bidang administrasi sistem jaringan.' },
  { title: 'LKS SMK — Cyber Security', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 60, tags: ['tkj', 'cyber', 'ctf'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'LKS bidang keamanan siber.' },
  { title: 'LKS SMK — Mobile Applications Development', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 60, tags: ['rpl', 'mobile', 'programming'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'LKS bidang pengembangan aplikasi mobile.' },
  { title: 'OSN Informatika', organizer: 'Puspresnas & TOKI', daysFromNow: 45, tags: ['rpl', 'programming', 'sains'], link: 'https://toki.id', description: 'Olimpiade Sains Nasional bidang informatika/computing.' },
  { title: 'FIKSI — Festival Inovasi dan Kewirausahaan Siswa Indonesia', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 35, tags: ['umum', 'bisnis', 'inovasi'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'Kompetisi rencana bisnis & inovasi siswa SMA/SMK.' },
  { title: 'OPSI — Olimpiade Penelitian Siswa Indonesia', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 50, tags: ['umum', 'karya-tulis', 'sains'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'Kompetisi penelitian ilmiah siswa, termasuk bidang teknik & rekayasa.' },
  { title: 'Lomba Karya Ilmiah Remaja (LKIR)', organizer: 'BRIN', daysFromNow: 70, tags: ['umum', 'karya-tulis', 'sains'], link: 'https://www.brin.go.id', description: 'Kompetisi karya ilmiah remaja tingkat nasional.' },
  { title: 'Bebras Challenge Indonesia', organizer: 'Bebras Indonesia', daysFromNow: 25, tags: ['rpl', 'tkj', 'it', 'umum'], link: 'https://bebras.or.id', description: 'Tantangan computational thinking untuk siswa.' },
  { title: 'Samsung Solve for Tomorrow', organizer: 'Samsung Indonesia', daysFromNow: 40, tags: ['umum', 'inovasi', 'it'], link: 'https://www.samsung.com/id/solvefortomorrow/', description: 'Kompetisi solusi inovatif berbasis STEM untuk masalah sekitar.' },
  { title: 'picoCTF', organizer: 'Carnegie Mellon University', daysFromNow: 120, tags: ['tkj', 'cyber', 'ctf'], link: 'https://picoctf.org', description: 'CTF internasional untuk pelajar SMA/SMK — bagus untuk latihan keamanan siber.' },
  { title: 'NASA Space Apps Challenge', organizer: 'NASA', daysFromNow: 90, tags: ['rpl', 'hackathon', 'data', 'umum'], link: 'https://www.spaceappschallenge.org', description: 'Hackathon global 48 jam dengan data terbuka NASA.' },
  { title: 'Swift Student Challenge', organizer: 'Apple', daysFromNow: 100, tags: ['rpl', 'mobile', 'programming'], link: 'https://developer.apple.com/swift-student-challenge/', description: 'Buat app playground Swift; terbuka untuk pelajar.' },
  { title: 'FLS2N — Desain Poster', organizer: 'Puspresnas Kemendikdasmen', daysFromNow: 55, tags: ['dkv', 'desain', 'poster', 'umum'], link: 'https://pusatprestasinas.kemdikbud.go.id', description: 'Festival Lomba Seni Siswa Nasional kategori desain poster.' },
  { title: 'Moklet Idea Challenge (MIC)', organizer: 'SMK Telkom Malang', daysFromNow: 30, tags: ['umum', 'inovasi', 'it', 'rpl', 'tkj'], link: 'https://www.smktelkom-mlg.sch.id', description: 'Kompetisi ide/inovasi teknologi digital.' },
  { title: 'Kompetisi UI/UX Pelajar', organizer: 'Himpunan mahasiswa (contoh)', daysFromNow: 20, tags: ['rpl', 'uiux', 'desain'], link: 'https://www.instagram.com/explore/tags/lombauiux/', description: 'Banyak kampus membuka lomba UI/UX tingkat SMA/SMK — kurasi dari akun info lomba.' },
  { title: 'Lomba IoT Pelajar', organizer: 'Himpunan mahasiswa (contoh)', daysFromNow: 28, tags: ['tkj', 'iot', 'hardware'], link: 'https://www.instagram.com/explore/tags/lombaiot/', description: 'Lomba rancang perangkat IoT tingkat SMA/SMK — kurasi dari akun info lomba.' },
];
