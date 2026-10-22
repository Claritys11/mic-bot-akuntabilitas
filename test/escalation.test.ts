import { describe, expect, test } from 'bun:test';
import { initialStage, nextStage, stageTime } from '../src/core/billing/escalation.ts';

const H = 3600_000;
const deadline = new Date('2026-10-23T13:00:00Z'); // Jumat 20:00 WIB

describe('aturan eskalasi tagihan', () => {
  test('waktu tiap tahap', () => {
    expect(stageTime('h2', deadline).getTime()).toBe(deadline.getTime() - 48 * H);
    expect(stageTime('h1', deadline).getTime()).toBe(deadline.getTime() - 24 * H);
    expect(stageTime('h0', deadline).getTime()).toBe(deadline.getTime() - 3 * H);
    expect(stageTime('overdue', deadline).getTime()).toBe(deadline.getTime() + 1 * H);
  });

  test('belum waktunya → null', () => {
    expect(nextStage(deadline, 'none', new Date(deadline.getTime() - 50 * H))).toBeNull();
  });

  test('tahap berurutan', () => {
    expect(nextStage(deadline, 'none', new Date(deadline.getTime() - 47 * H))).toBe('h2');
    expect(nextStage(deadline, 'h2', new Date(deadline.getTime() - 47 * H))).toBeNull();
    expect(nextStage(deadline, 'h2', new Date(deadline.getTime() - 23 * H))).toBe('h1');
    expect(nextStage(deadline, 'h1', new Date(deadline.getTime() - 2 * H))).toBe('h0');
    expect(nextStage(deadline, 'h0', new Date(deadline.getTime() + 2 * H))).toBe('overdue');
    expect(nextStage(deadline, 'overdue', new Date(deadline.getTime() + 99 * H))).toBeNull();
  });

  test('bot mati lama → lompat ke tahap terbaru, tidak spam semua tahap', () => {
    expect(nextStage(deadline, 'none', new Date(deadline.getTime() - 1 * H))).toBe('h0');
    expect(nextStage(deadline, 'h2', new Date(deadline.getTime() + 5 * H))).toBe('overdue');
  });

  test('janji dikonfirmasi mepet → tahap yang sudah lewat dianggap terkirim', () => {
    expect(initialStage(deadline, new Date(deadline.getTime() - 30 * H))).toBe('h2');
    expect(initialStage(deadline, new Date(deadline.getTime() - 72 * H))).toBe('none');
    // overdue tidak pernah dilewati diam-diam
    expect(initialStage(deadline, new Date(deadline.getTime() + 5 * H))).toBe('h0');
  });
});
