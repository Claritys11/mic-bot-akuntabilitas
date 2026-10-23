import { describe, expect, test } from 'bun:test';
import { parseClassName, parseKas, parseMajors } from '../src/core/onboarding/parse.ts';
import { relevance } from '../src/core/opps/relevance.ts';

describe('jawaban wawancara: nama kelas', () => {
  test('ambil nama kelas dari kalimat santai', () => {
    expect(parseClassName('XI International')).toBe('XI International');
    expect(parseClassName('kelas XI International kak')).toBe('XI International');
    expect(parseClassName('  kita XI RPL 2 ')).toBe('XI RPL 2');
  });
  test('terlalu pendek / kosong → null', () => {
    expect(parseClassName('')).toBeNull();
    expect(parseClassName('a')).toBeNull();
  });
});

describe('jawaban wawancara: jurusan', () => {
  test('daftar campur dipisah koma / "dan" / "&"', () => {
    expect(parseMajors('RPL, TKJ, dan PG')).toEqual(['RPL', 'TKJ', 'PG']);
    expect(parseMajors('rpl & tkj')).toEqual(['RPL', 'TKJ']);
    expect(parseMajors('jurusannya RPL')).toEqual(['RPL']);
  });
  test('tanpa duplikat', () => {
    expect(parseMajors('RPL, rpl, TKJ')).toEqual(['RPL', 'TKJ']);
  });
  test('tidak ada jurusan → kosong', () => {
    expect(parseMajors('hmm gatau')).toEqual([]);
  });
});

describe('jawaban wawancara: kas', () => {
  test('nominal + periode', () => {
    expect(parseKas('5rb seminggu')).toEqual({ amount: 5000, period: 'mingguan' });
    expect(parseKas('Rp10.000 per bulan')).toEqual({ amount: 10000, period: 'bulanan' });
    expect(parseKas('15k/minggu')).toEqual({ amount: 15000, period: 'mingguan' });
    expect(parseKas('20 ribu tiap bulan')).toEqual({ amount: 20000, period: 'bulanan' });
    expect(parseKas('2000 per pekan')).toEqual({ amount: 2000, period: 'mingguan' });
  });
  test('periode tidak disebut → bulanan', () => {
    expect(parseKas('10000')).toEqual({ amount: 10000, period: 'bulanan' });
  });
  test('tidak ada kas', () => {
    expect(parseKas('nggak ada kas')).toBe('none');
    expect(parseKas('gak ada')).toBe('none');
    expect(parseKas('tidak')).toBe('none');
  });
  test('tidak terbaca → null', () => {
    expect(parseKas('belum tau')).toBeNull();
    expect(parseKas('0')).toBeNull();
  });
});

describe('relevansi lomba untuk kelas multi-jurusan', () => {
  test('skor = jurusan paling cocok', () => {
    expect(relevance(['tkj', 'ctf'], 'RPL, TKJ, PG')).toBe(relevance(['tkj', 'ctf'], 'TKJ'));
    expect(relevance(['pg', 'game'], 'RPL, TKJ, PG')).toBe(4); // tag jurusan +3, game +1
  });
});
