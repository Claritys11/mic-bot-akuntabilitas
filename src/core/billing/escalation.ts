// Aturan eskalasi tagihan: H-2 halus → H-1 → H-0 tegas sopan → lewat deadline diumumkan ke grup.

export type Stage = 'h2' | 'h1' | 'h0' | 'overdue';
export type StageState = Stage | 'none';

export const STAGES: Stage[] = ['h2', 'h1', 'h0', 'overdue'];

const H = 3600_000;
const OFFSET: Record<Stage, number> = {
  h2: -48 * H,
  h1: -24 * H,
  h0: -3 * H,
  overdue: +1 * H,
};

export const stageTime = (stage: Stage, deadline: Date) => new Date(deadline.getTime() + OFFSET[stage]);

const rank = (s: StageState) => (s === 'none' ? -1 : STAGES.indexOf(s));

/**
 * Tahap yang perlu dikirim sekarang, atau null. Kalau beberapa tahap sudah jatuh tempo
 * (mis. bot mati semalaman), hanya tahap terbaru yang dikirim agar tidak spam.
 */
export function nextStage(deadline: Date, last: StageState, now: Date): Stage | null {
  let due: Stage | null = null;
  for (const s of STAGES) {
    if (stageTime(s, deadline) <= now) due = s;
  }
  if (!due || rank(due) <= rank(last)) return null;
  return due;
}

/**
 * Saat janji dikonfirmasi, tahap pengingat yang waktunya sudah lewat dianggap terkirim
 * (dikonfirmasi H-1 tidak langsung dapat pesan "H-2"). Tahap overdue tidak pernah dilewati.
 */
export function initialStage(deadline: Date, confirmedAt: Date): StageState {
  let state: StageState = 'none';
  for (const s of STAGES) {
    if (s !== 'overdue' && stageTime(s, deadline) <= confirmedAt) state = s;
  }
  return state;
}
