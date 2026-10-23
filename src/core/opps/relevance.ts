// Saring relevansi info lomba per kelas berdasarkan jurusan & tag.

const RELATED: Record<string, string[]> = {
  RPL: ['programming', 'software', 'web', 'mobile', 'ai', 'hackathon', 'uiux', 'game', 'data', 'it'],
  PPLG: ['programming', 'software', 'web', 'mobile', 'ai', 'hackathon', 'uiux', 'game', 'data', 'it'],
  TKJ: ['jaringan', 'network', 'cyber', 'ctf', 'iot', 'hardware', 'cloud', 'it'],
  TJKT: ['jaringan', 'network', 'cyber', 'ctf', 'iot', 'hardware', 'cloud', 'it'],
  // PG = Pengembangan Gim
  PG: ['game', 'programming', 'animasi', 'desain', 'uiux', 'it'],
  DKV: ['desain', 'uiux', 'poster', 'video', 'animasi'],
  ANIMASI: ['desain', 'animasi', 'video', 'game'],
};
const GENERAL = ['umum', 'inovasi', 'bisnis', 'karya-tulis', 'sains'];

/** Kelas bisa multi-jurusan ("RPL, TKJ, PG") → pakai jurusan yang paling cocok. */
export function relevance(tags: string[], major: string): number {
  const majors = major.split(/[,/&\s]+/).filter(Boolean);
  return Math.max(0, ...majors.map((m) => relevanceOne(tags, m)));
}

function relevanceOne(tags: string[], major: string): number {
  const t = new Set(tags.map((x) => x.toLowerCase()));
  const m = major.toUpperCase();
  let score = 0;
  if (t.has(m.toLowerCase())) score += 3;
  score += (RELATED[m] ?? []).filter((x) => t.has(x)).length;
  if (GENERAL.some((g) => t.has(g))) score += 2;
  return score;
}

export const MIN_LEAD_DAYS = 3;

export function pickNextOpportunity<T extends { id: string; tags: string[]; deadline: Date }>(
  opps: T[],
  major: string,
  postedIds: Set<string>,
  now: Date,
): T | null {
  const minDeadline = now.getTime() + MIN_LEAD_DAYS * 86400_000;
  const ranked = opps
    .filter((o) => !postedIds.has(o.id) && o.deadline.getTime() >= minDeadline)
    .map((o) => ({ o, score: relevance(o.tags, major) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.o.deadline.getTime() - b.o.deadline.getTime());
  return ranked[0]?.o ?? null;
}
