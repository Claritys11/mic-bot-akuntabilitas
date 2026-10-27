import { describe, expect, test } from 'bun:test';
import { pilotMetrics, type PromiseRow } from '../src/core/pilot/metrics.ts';

const d = (s: string) => new Date(s);
const NOW = d('2026-11-10T00:00:00Z');
const row = (p: Partial<PromiseRow>): PromiseRow => ({ status: 'active', deadline: null, doneAt: null, createdAt: d('2026-11-01T00:00:00Z'), ...p });

describe('metrik pilot', () => {
  test('ketepatan janji, telat, dan salah-aktif', () => {
    const m = pilotMetrics(
      [
        row({ status: 'done', deadline: d('2026-11-05T13:00:00Z'), doneAt: d('2026-11-05T10:00:00Z') }), // tepat
        row({ status: 'done', deadline: d('2026-11-05T13:00:00Z'), doneAt: d('2026-11-07T13:00:00Z') }), // telat 2 hari
        row({ status: 'overdue', deadline: d('2026-11-06T13:00:00Z') }), // lewat
        row({ status: 'active', deadline: d('2026-11-20T13:00:00Z') }), // belum jatuh tempo
        row({ status: 'cancelled', autoActivated: true, ownerTouched: false }), // salah-aktif
        row({ status: 'done', autoActivated: true, ownerTouched: true, deadline: d('2026-11-08T13:00:00Z'), doneAt: d('2026-11-08T12:00:00Z') }),
        row({ status: 'pending_confirm', createdAt: d('2026-11-01T00:00:00Z') }), // tak pernah dikonfirmasi
      ],
      [
        { status: 'approved', nominal: 10000, flags: [] },
        { status: 'approved', nominal: 20000, flags: ['amount_mismatch'] },
        { status: 'rejected', nominal: null, flags: ['similar_image'] },
      ],
      NOW,
    );
    expect(m).toMatchObject({ recorded: 5, due: 4, onTime: 2, late: 1, missed: 1, keptPct: 50, avgDaysLate: 2, neverConfirmed: 1 });
    expect(m).toMatchObject({ autoActivated: 2, falseActivations: 1, falseActivationPct: 50 });
    expect(m.kas).toEqual({ approved: 2, approvedTotal: 30000, rejected: 1, flagged: 2, pending: 0 });
  });

  test('belum ada data → null, bukan 0%', () => {
    const m = pilotMetrics([], [], NOW);
    expect(m.keptPct).toBeNull();
    expect(m.falseActivationPct).toBeNull();
  });
});

describe('ekspor CSV pilot', () => {
  test('kolom cek ketua kosong & nama berbahaya dinetralkan', async () => {
    const { promisesCsv } = await import('../src/core/pilot/service.ts');
    const csv = promisesCsv([
      { task: 'bikin PPT', owner: { platformUserId: 'u1', displayName: '=HACK()' }, deadline: d('2026-11-05T13:00:00Z'), status: 'done', doneAt: d('2026-11-05T10:00:00Z'), shadow: true, autoActivated: false, createdAt: d('2026-11-01T03:00:00Z') },
    ]);
    const [head, row] = csv.split('\n');
    expect(head).toContain('dicek_ketua_ditepati');
    expect(row).toContain("'=HACK()");
    expect(row).toContain(',diam,tidak,');
    expect(row!.endsWith(',')).toBe(true);
  });
});
