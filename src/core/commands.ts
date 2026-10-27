// Definisi slash command yang netral platform. Discord merender jadi slash command;
// WhatsApp nanti bisa merender jadi perintah teks ("!janji list").

export type OptionType = 'string' | 'integer' | 'boolean' | 'user' | 'channel';

export interface OptionSpec {
  name: string;
  description: string;
  type: OptionType;
  required?: boolean;
  choices?: { name: string; value: string }[];
}

export interface CommandSpec {
  name: string;
  description: string;
  adminOnly?: boolean;
  options?: OptionSpec[];
  subcommands?: { name: string; description: string; options?: OptionSpec[] }[];
}

const TUTUR = [
  { name: 'santai', value: 'santai' },
  { name: 'sopan', value: 'sopan' },
  { name: 'krama (Jawa)', value: 'krama' },
];

export const COMMANDS: CommandSpec[] = [
  { name: 'ping', description: 'Cek bot hidup' },
  {
    name: 'setup',
    description: 'Atur kelas ini — kosongkan opsi untuk diwawancarai bot',
    adminOnly: true,
    options: [
      { name: 'kelas', description: 'Nama kelas, mis. XI RPL 2 (kosong = wawancara)', type: 'string' },
      { name: 'jurusan', description: 'Jurusan, mis. RPL, TKJ, PG', type: 'string' },
      { name: 'tutur', description: 'Tingkat tutur bot', type: 'string', choices: TUTUR },
      { name: 'channel_kas', description: 'Channel untuk bukti transfer kas', type: 'channel' },
      { name: 'channel_lomba', description: 'Channel untuk info lomba', type: 'channel' },
    ],
  },
  {
    name: 'janji',
    description: 'Janji/komitmen kelas',
    subcommands: [
      { name: 'list', description: 'Daftar janji aktif', options: [{ name: 'punyaku', description: 'Hanya janjiku', type: 'boolean' }] },
      { name: 'selesai', description: 'Tandai janjiku selesai' },
    ],
  },
  { name: 'rapor-kelas', description: 'Skor ketepatan janji kelas (bukan individu)' },
  {
    name: 'kas',
    description: 'Kas kelas',
    subcommands: [
      {
        name: 'atur',
        description: 'Atur iuran kas (pengurus)',
        options: [
          { name: 'nominal', description: 'Iuran per periode (rupiah)', type: 'integer', required: true },
          { name: 'periode', description: 'Periode iuran', type: 'string', required: true, choices: [{ name: 'mingguan', value: 'mingguan' }, { name: 'bulanan', value: 'bulanan' }] },
          { name: 'bendahara', description: 'Bendahara kelas', type: 'user' },
          { name: 'penerima', description: 'Nama rekening/e-wallet tujuan kas, pisahkan koma (untuk cek bukti)', type: 'string' },
          {
            name: 'cek_bukti',
            description: 'Bukti transfer dicek di mana',
            type: 'string',
            choices: [
              { name: 'DM bendahara', value: 'dm' },
              { name: 'Channel tim inti (dibuatkan kalau belum ada)', value: 'channel' },
            ],
          },
          { name: 'channel_tim', description: 'Pakai channel tim inti yang sudah ada (opsional)', type: 'channel' },
          { name: 'tambah_tim', description: 'Tambah anggota tim inti (boleh menyetujui bukti kas)', type: 'user' },
          { name: 'hapus_tim', description: 'Keluarkan anggota dari tim inti', type: 'user' },
        ],
      },
      { name: 'rekap', description: 'Siapa sudah/belum bayar periode ini', options: [{ name: 'umumkan', description: 'Tampilkan ke semua (bendahara)', type: 'boolean' }] },
      { name: 'ekspor', description: 'Ekspor ledger CSV (bahan LPJ)' },
    ],
  },
  {
    name: 'pilot',
    description: 'Mode pilot (pengurus): baseline diam-diam & ekspor data',
    adminOnly: true,
    subcommands: [
      {
        name: 'mode',
        description: 'diam = hanya mencatat (baseline), aktif = normal, jeda = berhenti total',
        options: [{ name: 'mode', description: 'Mode bot', type: 'string', required: true, choices: [{ name: 'diam (baseline)', value: 'diam' }, { name: 'aktif', value: 'aktif' }, { name: 'jeda (rem darurat)', value: 'jeda' }] }],
      },
      { name: 'ekspor', description: 'Ekspor janji tercatat (CSV) untuk dicek ketua kelas' },
    ],
  },
  {
    name: 'data',
    description: 'Hapus data (hak menarik persetujuan)',
    subcommands: [
      { name: 'hapus-saya', description: 'Hapus permanen datamu di kelas ini' },
      { name: 'hapus-anggota', description: 'Hapus data seorang anggota (pengurus)', options: [{ name: 'anggota', description: 'Anggota', type: 'user', required: true }] },
      { name: 'hapus-kelas', description: 'Hapus SEMUA data kelas ini (pengurus)' },
    ],
  },
  {
    name: 'ingetin',
    description: 'Minta diingatkan (bisa juga: "@MIC ingetin aku besok jam 7 …")',
    options: [
      { name: 'apa', description: 'Mau diingetin soal apa', type: 'string', required: true },
      { name: 'kapan', description: 'Mis. besok jam 7, jumat sore, tgl 30', type: 'string', required: true },
      { name: 'untuk', description: 'Untuk siapa', type: 'string', choices: [{ name: 'aku saja (DM)', value: 'aku' }, { name: 'seluruh kelas', value: 'kelas' }] },
    ],
  },
  {
    name: 'rangkum',
    description: 'Rangkum obrolan channel ini',
    options: [{ name: 'jam', description: 'Berapa jam terakhir (1–48, default 3)', type: 'integer' }],
  },
  {
    name: 'lomba',
    description: 'Info lomba',
    subcommands: [
      { name: 'list', description: 'Lomba yang cocok untuk jurusan kelas ini' },
      {
        name: 'tambah',
        description: 'Tambah info lomba (admin)',
        options: [
          { name: 'link', description: 'Link info lomba — cukup ini, sisanya aku baca sendiri', type: 'string', required: true },
          { name: 'judul', description: 'Isi manual kalau link tidak terbaca', type: 'string' },
          { name: 'deadline', description: 'YYYY-MM-DD (manual)', type: 'string' },
          { name: 'penyelenggara', description: 'Penyelenggara', type: 'string' },
          { name: 'tag', description: 'Tag dipisah koma, mis. rpl,web', type: 'string' },
          { name: 'deskripsi', description: 'Deskripsi singkat', type: 'string' },
          { name: 'promosi', description: 'Konten berbayar/sponsor?', type: 'boolean' },
        ],
      },
    ],
  },
];
