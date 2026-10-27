// Metrik pilot (kelas dengan bot vs kelas kontrol). Murni — dihitung dari dokumen DB oleh scripts/pilot-metrics.ts.

const DAY = 86400_000;

export interface PromiseRow {
  status: string;
  deadline: Date | null;
  doneAt: Date | null;
  createdAt: Date;
  autoActivated?: boolean | null;
  ownerTouched?: boolean | null;
}

export interface ProofRow {
  status: string;
  nominal: number | null;
  flags: string[];
}

export interface PilotMetrics {
  /** Janji yang tercatat aktif (dikonfirmasi atau auto-aktif), termasuk yang sudah selesai/lewat. */
  recorded: number;
  /** Ditanya tapi tidak pernah dikonfirmasi (> 1 hari) — indikasi janji yang "lolos" dari pelacakan. */
  neverConfirmed: number;
  /** Janji tercatat yang deadline-nya sudah lewat → bisa dinilai. */
  due: number;
  onTime: number;
  late: number;
  missed: number;
  /** onTime / due (0–100), null kalau belum ada yang jatuh tempo. */
  keptPct: number | null;
  /** Rata-rata hari telat untuk yang selesai terlambat. */
  avgDaysLate: number | null;
  autoActivated: number;
  /** Auto-aktif lalu dibatalkan pemiliknya ("bukan janjiku") sebelum pernah diakui. */
  falseActivations: number;
  falseActivationPct: number | null;
  kas: { approved: number; approvedTotal: number; rejected: number; flagged: number; pending: number };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export function pilotMetrics(promises: PromiseRow[], proofs: ProofRow[], now: Date): PilotMetrics {
  const tracked = promises.filter((p) => ['active', 'done', 'overdue'].includes(p.status));
  const due = tracked.filter((p) => p.deadline && p.deadline <= now);
  let onTime = 0;
  let late = 0;
  let missed = 0;
  let lateDays = 0;
  for (const p of due) {
    if (p.status === 'done' && p.doneAt) {
      if (p.doneAt <= p.deadline!) onTime++;
      else {
        late++;
        lateDays += (p.doneAt.getTime() - p.deadline!.getTime()) / DAY;
      }
    } else missed++;
  }
  const auto = promises.filter((p) => p.autoActivated);
  const falseActivations = auto.filter((p) => p.status === 'cancelled' && !p.ownerTouched).length;
  return {
    recorded: tracked.length,
    neverConfirmed: promises.filter((p) => p.status === 'pending_confirm' && now.getTime() - p.createdAt.getTime() > DAY).length,
    due: due.length,
    onTime,
    late,
    missed,
    keptPct: pct(onTime, due.length),
    avgDaysLate: late ? Math.round((lateDays / late) * 10) / 10 : null,
    autoActivated: auto.length,
    falseActivations,
    falseActivationPct: pct(falseActivations, auto.length),
    kas: {
      approved: proofs.filter((p) => p.status === 'approved').length,
      approvedTotal: proofs.filter((p) => p.status === 'approved').reduce((s, p) => s + (p.nominal ?? 0), 0),
      rejected: proofs.filter((p) => p.status === 'rejected').length,
      flagged: proofs.filter((p) => p.flags.length > 0).length,
      pending: proofs.filter((p) => p.status === 'pending').length,
    },
  };
}
