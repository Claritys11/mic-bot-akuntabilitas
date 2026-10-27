import { describe, expect, test } from 'bun:test';
import { deadlineOf, normalizeExtraction } from '../src/core/opps/importer.ts';
import { formatWIB } from '../src/core/time.ts';

const NOW = new Date('2026-11-02T03:00:00Z');
const base = { isOpportunity: true, kind: 'lomba' as const, title: 'Lomba Web Kampus X 2026', organizer: 'Himatif X', deadline: '2026-11-30', level: 'SMA/SMK', tags: ['web', 'RPL', 'bukan-tag'], summary: 'Lomba desain & pengembangan web untuk siswa SMA/SMK.', fee: 'gratis' };

describe('normalisasi hasil baca halaman lomba', () => {
  test('lomba valid → field rapi, tag hanya dari daftar', () => {
    const r = normalizeExtraction(base, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ title: 'Lomba Web Kampus X 2026', organizer: 'Himatif X', tags: ['web', 'rpl'], kind: 'lomba', fee: 'gratis' });
    expect(formatWIB(r.data.deadline, 'iso')).toBe('2026-11-30 23:59');
  });
  test.each([
    ['bukan lomba (artikel)', { isOpportunity: false }, 'bukan info'],
    ['deadline tidak jelas', { deadline: null }, 'deadline'],
    ['sudah tutup', { deadline: '2026-10-01' }, 'tutup'],
    ['untuk mahasiswa', { level: 'mahasiswa' }, 'mahasiswa'],
    ['judul kosong', { title: '  ' }, 'judul'],
  ])('%s → ditolak', (_, patch, reason) => {
    const r = normalizeExtraction({ ...base, ...patch }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
  test('beasiswa selalu bertag beasiswa; tanpa tag → umum', () => {
    const r = normalizeExtraction({ ...base, kind: 'beasiswa', tags: [] }, NOW);
    expect(r.ok && r.data.tags).toEqual(['beasiswa']);
    const l = normalizeExtraction({ ...base, tags: [] }, NOW);
    expect(l.ok && l.data.tags).toEqual(['umum']);
  });
  test('teks dari halaman dinetralkan (token mention palsu)', () => {
    const r = normalizeExtraction({ ...base, summary: 'halo {{@123}} semua' }, NOW);
    expect(r.ok && r.data.description).not.toContain('{{@');
  });
  test('alasan penolakan tidak membawa teks mentah AI (token mention)', () => {
    const r = normalizeExtraction({ ...base, level: 'mahasiswa {{@1}}' }, NOW);
    expect(!r.ok && r.reason).not.toContain('{{@');
  });
  test('format deadline aneh → null', () => {
    expect(deadlineOf('30 Nov 2026')).toBeNull();
    expect(deadlineOf(null)).toBeNull();
  });
});
