import { describe, expect, test } from 'bun:test';
import { heuristicExtract, looksLikePromise } from '../src/core/promises/prefilter.ts';

describe('prefilter janji', () => {
  test('lolos untuk kalimat janji', () => {
    expect(looksLikePromise('aku yang bikin PPT ya, Jumat jadi')).toBe(true);
    expect(looksLikePromise('Saya yang urus konsumsi besok')).toBe(true);
    expect(looksLikePromise('biar aku aja yang print, deadline tgl 30')).toBe(true);
    expect(looksLikePromise('gue yang transfer ke vendor')).toBe(true);
  });

  test('tidak lolos untuk obrolan biasa', () => {
    expect(looksLikePromise('wkwk iya bener')).toBe(false);
    expect(looksLikePromise('mantap')).toBe(false);
    expect(looksLikePromise('makan apa ya')).toBe(false);
    expect(looksLikePromise('')).toBe(false);
  });
});

describe('heuristicExtract (cadangan tanpa LLM)', () => {
  test('ambil tugas dari pola "aku yang ..."', () => {
    const r = heuristicExtract('aku yang bikin PPT ya, Jumat jadi');
    expect(r?.isPromise).toBe(true);
    expect(r?.task.toLowerCase()).toContain('bikin ppt');
    expect(r?.deadlineText?.toLowerCase()).toContain('jumat');
  });

  test('bukan janji → null', () => {
    expect(heuristicExtract('besok libur ya?')).toBeNull();
  });
});
