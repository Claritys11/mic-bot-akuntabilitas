import { describe, expect, test } from 'bun:test';
import { shouldAutoActivate, similarTask } from '../src/core/promises/autoActivate.ts';

const base = { source: 'llm' as const, confidence: 0.9, ownerIsAuthor: true, hasDeadline: true };

describe('janji auto-aktif', () => {
  test('LLM yakin + pemilik sendiri + ada deadline → langsung aktif', () => {
    expect(shouldAutoActivate(base)).toBe(true);
  });
  test.each([
    ['heuristik saja (LLM mati)', { source: 'heuristic' as const }],
    ['confidence sedang', { confidence: 0.7 }],
    ['menunjuk orang lain', { ownerIsAuthor: false }],
    ['tanpa deadline', { hasDeadline: false }],
  ])('%s → tetap minta konfirmasi', (_, patch) => {
    expect(shouldAutoActivate({ ...base, ...patch })).toBe(false);
  });
});

describe('janji yang diulang', () => {
  test.each([
    ['bikin PPT', 'bikin ppt presentasi', true],
    ['bikin PPT ya', 'Bikin PPT', true],
    ['rangkum bab 3', 'rangkum materi bab 3', true],
    ['bikin PPT', 'print laporan', false],
    ['beli spidol', 'beli kertas', false],
  ])('%p vs %p → %p', (a, b, want) => {
    expect(similarTask(a, b)).toBe(want);
  });
});
