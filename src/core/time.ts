// Waktu Asia/Jakarta (UTC+7, tanpa DST) + jam virtual untuk demo.

export const WIB_OFFSET_MS = 7 * 3600_000;
export const DAY_MS = 24 * 3600_000;

/** Komponen kalender WIB dari sebuah Date. */
export function wibParts(d: Date) {
  const s = new Date(d.getTime() + WIB_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth(), // 0-11
    day: s.getUTCDate(),
    weekday: s.getUTCDay(), // 0 = Minggu
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
  };
}

/** Bangun Date dari komponen kalender WIB. Bulan/hari boleh overflow (Date.UTC menormalkan). */
export function fromWIB(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - WIB_OFFSET_MS);
}

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const pad = (n: number) => String(n).padStart(2, '0');

export function formatWIB(d: Date, style: 'human' | 'iso' | 'date' = 'human'): string {
  const p = wibParts(d);
  if (style === 'iso') return `${p.year}-${pad(p.month + 1)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  if (style === 'date') return `${p.day} ${BULAN[p.month]} ${p.year}`;
  return `${HARI[p.weekday]}, ${p.day} ${BULAN[p.month]} ${pad(p.hour)}:${pad(p.minute)} WIB`;
}

/**
 * Jam yang bisa dipercepat (DEMO_TIME_SCALE). scale=1440 → 1 menit nyata = 1 hari virtual.
 * Waktu virtual dihitung dari saat proses mulai, jadi restart = kembali ke waktu nyata.
 */
export class Clock {
  private readonly realStart = Date.now();
  constructor(readonly scale = 1) {}

  now(): Date {
    if (this.scale === 1) return new Date();
    return new Date(this.realStart + (Date.now() - this.realStart) * this.scale);
  }
}

let clock = new Clock(1);
export const setClock = (c: Clock) => {
  clock = c;
};
export const now = () => clock.now();
export const timeScale = () => clock.scale;
